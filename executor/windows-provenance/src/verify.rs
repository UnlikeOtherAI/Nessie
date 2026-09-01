//! The Win32 half of the Windows release check.
//!
//! `WinVerifyTrust` answers "is this file's Authenticode signature valid and
//! trusted", never "who signed it" — an attacker with any code-signing
//! certificate produces a file that passes it. The signer certificate has to be
//! read out of the verification state and compared to the publisher compiled
//! into the release, which is what [`super::decide_release_signature`] does with
//! the facts this module collects.

use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::TRUE;
use windows_sys::Win32::Security::Cryptography::{
    CertGetCertificateContextProperty, CERT_HASH_PROP_ID,
};
use windows_sys::Win32::Security::WinTrust::{
    WinVerifyTrust, WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain,
    WTHelperProvDataFromStateData, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA,
    WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE,
    WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};

use super::WindowsSignatureFacts;

/// A SHA-1 thumbprint is 20 bytes, rendered as 40 hexadecimal characters.
const THUMBPRINT_BYTES: usize = 20;

fn wide(path: &std::path::Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn hexadecimal(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The signer's SHA-1 thumbprint, read from the state `WinVerifyTrust` left
/// behind. Read only after a successful verification: on failure the chain may
/// be absent or incomplete, and a thumbprint from an untrusted chain would be
/// exactly the value an attacker controls.
unsafe fn signer_thumbprint(state: *mut std::ffi::c_void) -> Option<String> {
    let provider = WTHelperProvDataFromStateData(state);
    if provider.is_null() {
        return None;
    }
    // Signer 0, chain 0: the first signature's leaf certificate — the publisher.
    let signer = WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
    if signer.is_null() {
        return None;
    }
    let certificate = WTHelperGetProvCertFromChain(signer, 0);
    if certificate.is_null() {
        return None;
    }
    let context = (*certificate).pCert;
    if context.is_null() {
        return None;
    }
    let mut thumbprint = [0_u8; THUMBPRINT_BYTES];
    let mut size = THUMBPRINT_BYTES as u32;
    let read = CertGetCertificateContextProperty(
        context,
        CERT_HASH_PROP_ID,
        thumbprint.as_mut_ptr().cast(),
        &mut size,
    );
    if read != TRUE || size as usize != THUMBPRINT_BYTES {
        return None;
    }
    Some(hexadecimal(&thumbprint))
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
        signer_thumbprint: if verified == 0 {
            unsafe { signer_thumbprint(data.hWVTStateData) }
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
