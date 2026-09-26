//! The Win32 half of the Windows release check.
//!
//! `WinVerifyTrust` answers "is this file's Authenticode signature valid and
//! trusted", never "who signed it" — an attacker with any code-signing
//! certificate produces a file that passes it. The signer certificate has to be
//! read out of the verification state and its durable profile EKU compared to
//! the publisher identity compiled into the release, which is what
//! [`super::decide_release_signature`] does with the facts this module collects.

use std::ffi::CStr;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::TRUE;
use windows_sys::Win32::Security::Cryptography::{
    CertGetEnhancedKeyUsage, CERT_CONTEXT, CTL_USAGE,
};
use windows_sys::Win32::Security::WinTrust::{
    WinVerifyTrust, WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain,
    WTHelperProvDataFromStateData, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA,
    WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
    WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};

use super::WindowsSignatureFacts;

fn wide(path: &std::path::Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// The signer's leaf certificate from the state `WinVerifyTrust` left behind.
/// Read only after a successful verification: on failure the chain may be
/// absent or incomplete, and certificate fields would be attacker-controlled.
unsafe fn signer_certificate(state: *mut std::ffi::c_void) -> *const CERT_CONTEXT {
    let provider = WTHelperProvDataFromStateData(state);
    if provider.is_null() {
        return std::ptr::null();
    }
    // Signer 0, chain 0: the first signature's leaf certificate — the publisher.
    let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
    if signer.is_null() {
        return std::ptr::null();
    }
    let certificate = WTHelperGetProvCertFromChain(signer, 0);
    if certificate.is_null() {
        return std::ptr::null();
    }
    (*certificate).pCert
}

/// All EKUs in the trusted leaf certificate. Artifact Signing renews its leaf
/// certificate daily but keeps the profile-specific `1.3.6.1.4.1.311.97.*`
/// EKU stable for the lifetime of the certificate profile.
unsafe fn signer_enhanced_key_usages(state: *mut std::ffi::c_void) -> Option<Vec<String>> {
    let context = signer_certificate(state);
    if context.is_null() {
        return None;
    }

    let mut size = 0_u32;
    if CertGetEnhancedKeyUsage(context, 0, std::ptr::null_mut(), &mut size) != TRUE
        || size < std::mem::size_of::<CTL_USAGE>() as u32
    {
        return None;
    }
    // `Vec<usize>` supplies alignment suitable for CTL_USAGE (the Win32
    // `CERT_ENHKEY_USAGE` typedef) while
    // still giving the Win32 API the requested byte count.
    let words = (size as usize).div_ceil(std::mem::size_of::<usize>());
    let mut buffer = vec![0_usize; words];
    let usage = buffer.as_mut_ptr().cast::<CTL_USAGE>();
    if CertGetEnhancedKeyUsage(context, 0, usage, &mut size) != TRUE {
        return None;
    }
    if (*usage).cUsageIdentifier == 0 || (*usage).rgpszUsageIdentifier.is_null() {
        return Some(Vec::new());
    }
    let identifiers = std::slice::from_raw_parts(
        (*usage).rgpszUsageIdentifier,
        (*usage).cUsageIdentifier as usize,
    );
    identifiers
        .iter()
        .map(|identifier| {
            if (*identifier).is_null() {
                return None;
            }
            CStr::from_ptr((*identifier).cast()).to_str().ok().map(str::to_owned)
        })
        .collect()
}

/// Verifies the file's Authenticode signature with no UI and no network:
/// revocation is `WTD_REVOKE_NONE` with cache-only URL retrieval, because a
/// computer that boots offline must not lose its executor to a CRL fetch that
/// cannot complete. The state handle is always closed.
pub fn collect_signature_facts(path: &std::path::Path) -> Option<WindowsSignatureFacts> {
    let wide_path = wide(path);
    let mut file = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: wide_path.as_ptr(),
        hFile: std::ptr::null_mut(),
        pgKnownSubject: std::ptr::null_mut(),
    };
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL;
    data.Anonymous = WINTRUST_DATA_0 { pFile: &mut file };

    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let verified = unsafe {
        WinVerifyTrust(std::ptr::null_mut(), &mut action, (&mut data as *mut WINTRUST_DATA).cast())
    };
    let facts = WindowsSignatureFacts {
        signer_enhanced_key_usages: if verified == 0 {
            unsafe { signer_enhanced_key_usages(data.hWVTStateData) }
        } else {
            None
        },
        trusted: verified == 0,
    };
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe {
        WinVerifyTrust(std::ptr::null_mut(), &mut action, (&mut data as *mut WINTRUST_DATA).cast())
    };
    Some(facts)
}
