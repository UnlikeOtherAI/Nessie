//! Owner-only private state, proved the way the host proves it.
//!
//! POSIX supervisors read `uid` and mode bits directly and never call the
//! helper. Windows reports `0o666`-style modes and no uid, so there is nothing
//! for the supervisor to read: privacy there is a DACL, and establishing and
//! reading one needs Win32. These two commands are that adapter, and nothing
//! else in the helper depends on them.

use crate::protocol::NativeError;

/// The three codes a supervisor may read back. All three are part of the
/// contract on every host, but each build can only ever return some of them:
/// only Windows verifies a DACL, and only the other hosts refuse to try.
#[cfg_attr(windows, allow(dead_code))]
pub const UNSUPPORTED: &str = "EXECUTOR_STATE_SECURITY_UNSUPPORTED";
#[cfg_attr(not(windows), allow(dead_code))]
pub const REJECTED: &str = "EXECUTOR_STATE_SECURITY_REJECTED";
#[cfg_attr(not(windows), allow(dead_code))]
pub const IO_FAILURE: &str = "EXECUTOR_STATE_SECURITY_IO_FAILURE";

/// Create the directory if absent and give it an explicit, non-inherited DACL
/// granting full control to the current user and SYSTEM alone.
pub fn secure_directory(path: &str) -> Result<(), NativeError> {
    imp::secure_directory(path)
}

/// Prove that a directory is still owned by the current user and that every ACE
/// on it admits only that user or SYSTEM, with nothing inherited.
pub fn verify_owner_only(path: &str) -> Result<(), NativeError> {
    imp::verify_owner_only(path)
}

#[cfg(not(windows))]
mod imp {
    use super::{NativeError, UNSUPPORTED};

    pub fn secure_directory(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }

    pub fn verify_owner_only(_path: &str) -> Result<(), NativeError> {
        Err(NativeError::new(UNSUPPORTED))
    }
}

#[cfg(windows)]
mod imp {
    use super::{NativeError, IO_FAILURE, REJECTED};
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
        NO_MULTIPLE_TRUSTEE, SET_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID, TRUSTEE_IS_USER,
        TRUSTEE_IS_WELL_KNOWN_GROUP, TRUSTEE_W,
    };
    use windows_sys::Win32::Security::{
        CopySid, CreateWellKnownSid, EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
        GetTokenInformation, IsValidSid, TokenUser, WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACL,
        DACL_SECURITY_INFORMATION, INHERITED_ACE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_MAX_SID_SIZE,
        SE_DACL_PROTECTED, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// `ACCESS_ALLOWED_ACE_TYPE`. Every other ACE type has a different body, so
    /// the reader refuses them rather than reading one at the wrong offset.
    const ACCESS_ALLOWED: u8 = 0;

    fn wide(path: &str) -> Vec<u16> {
        OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// A SID copied out of the buffer that produced it, so the buffer's life
    /// stops mattering to every later comparison.
    struct OwnedSid(Vec<u8>);

    impl OwnedSid {
        fn pointer(&self) -> PSID {
            self.0.as_ptr() as PSID
        }
    }

    fn copy_sid(source: PSID) -> Result<OwnedSid, NativeError> {
        if source.is_null() || unsafe { IsValidSid(source) } == 0 {
            return Err(NativeError::new(REJECTED));
        }
        let length = unsafe { GetLengthSid(source) } as usize;
        let mut bytes = vec![0_u8; length];
        if unsafe { CopySid(length as u32, bytes.as_mut_ptr() as PSID, source) } == 0 {
            return Err(NativeError::new(IO_FAILURE));
        }
        Ok(OwnedSid(bytes))
    }

    /// The SID of the account this process runs as. Everything owner-only is
    /// decided against this one value.
    fn current_user_sid() -> Result<OwnedSid, NativeError> {
        let mut token: HANDLE = INVALID_HANDLE_VALUE;
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(NativeError::new(IO_FAILURE));
        }
        let mut needed = 0_u32;
        unsafe { GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed) };
        let mut buffer = vec![0_u8; needed.max(1) as usize];
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                &mut needed,
            )
        };
        let sid = if read == 0 {
            Err(NativeError::new(IO_FAILURE))
        } else {
            copy_sid(unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid })
        };
        unsafe { CloseHandle(token) };
        sid
    }

    fn local_system_sid() -> Result<OwnedSid, NativeError> {
        let mut bytes = vec![0_u8; SECURITY_MAX_SID_SIZE as usize];
        let mut size = SECURITY_MAX_SID_SIZE;
        let created = unsafe {
            CreateWellKnownSid(
                WinLocalSystemSid,
                std::ptr::null_mut(),
                bytes.as_mut_ptr() as PSID,
                &mut size,
            )
        };
        if created == 0 {
            return Err(NativeError::new(IO_FAILURE));
        }
        bytes.truncate(size as usize);
        Ok(OwnedSid(bytes))
    }

    fn full_control(sid: PSID, trustee_type: i32) -> EXPLICIT_ACCESS_W {
        EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: SET_ACCESS,
            grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: std::ptr::null_mut(),
                MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: trustee_type,
                ptstrName: sid as *mut u16,
            },
        }
    }

    pub fn secure_directory(path: &str) -> Result<(), NativeError> {
        std::fs::create_dir_all(path).map_err(|_| NativeError::new(IO_FAILURE))?;
        let user = current_user_sid()?;
        let system = local_system_sid()?;
        let entries = [
            full_control(user.pointer(), TRUSTEE_IS_USER),
            full_control(system.pointer(), TRUSTEE_IS_WELL_KNOWN_GROUP),
        ];
        let mut acl: *mut ACL = std::ptr::null_mut();
        if unsafe { SetEntriesInAclW(2, entries.as_ptr(), std::ptr::null(), &mut acl) }
            != ERROR_SUCCESS
        {
            return Err(NativeError::new(IO_FAILURE));
        }
        // PROTECTED severs inheritance, so a permissive ACE on any parent — a
        // roaming profile, an administrator's earlier grant — cannot reach the
        // state directory. Owner is re-stamped because only an owner can later
        // repair a DACL it does not appear in.
        let applied = unsafe {
            SetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION
                    | DACL_SECURITY_INFORMATION
                    | PROTECTED_DACL_SECURITY_INFORMATION,
                user.pointer(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null(),
            )
        };
        unsafe { LocalFree(acl as HLOCAL) };
        if applied != ERROR_SUCCESS {
            return Err(NativeError::new(IO_FAILURE));
        }
        // Establishing and proving are the same command's job: a DACL that did
        // not take is indistinguishable from one never asked for.
        verify_owner_only(path)
    }

    /// Every ACE of a protected DACL, read once. A NULL DACL is world-writable
    /// and an empty one is not: absence of the pointer is the failure.
    fn admits_only(acl: *const ACL, user: &OwnedSid, system: &OwnedSid) -> bool {
        if acl.is_null() {
            return false;
        }
        let count = unsafe { (*acl).AceCount };
        for index in 0..count {
            let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
            if unsafe { GetAce(acl, u32::from(index), &mut ace) } == 0 || ace.is_null() {
                return false;
            }
            let entry = ace.cast::<ACCESS_ALLOWED_ACE>();
            let header = unsafe { (*entry).Header };
            if header.AceType != ACCESS_ALLOWED || u32::from(header.AceFlags) & INHERITED_ACE != 0 {
                return false;
            }
            let sid = unsafe { std::ptr::addr_of!((*entry).SidStart) } as PSID;
            if unsafe { IsValidSid(sid) } == 0 {
                return false;
            }
            let admitted = unsafe { EqualSid(sid, user.pointer()) } != 0
                || unsafe { EqualSid(sid, system.pointer()) } != 0;
            if !admitted {
                return false;
            }
        }
        true
    }

    pub fn verify_owner_only(path: &str) -> Result<(), NativeError> {
        let user = current_user_sid()?;
        let system = local_system_sid()?;
        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let read = unsafe {
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut dacl,
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if read != ERROR_SUCCESS {
            return Err(NativeError::new(IO_FAILURE));
        }
        let mut control = 0_u16;
        let mut revision = 0_u32;
        let described =
            unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } != 0;
        let owned = !owner.is_null()
            && unsafe { IsValidSid(owner) } != 0
            && unsafe { EqualSid(owner, user.pointer()) } != 0;
        let verdict = described
            && owned
            && control & SE_DACL_PROTECTED != 0
            && admits_only(dacl, &user, &system);
        unsafe { LocalFree(descriptor as HLOCAL) };
        if verdict {
            Ok(())
        } else {
            Err(NativeError::new(REJECTED))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{secure_directory, verify_owner_only, IO_FAILURE, REJECTED, UNSUPPORTED};

    /// The codes are part of the contract the supervisor reads, and none of
    /// them may carry a path or a reason a person should not see.
    #[test]
    fn the_codes_are_stable_and_name_no_path() {
        for code in [UNSUPPORTED, REJECTED, IO_FAILURE] {
            assert!(code.starts_with("EXECUTOR_STATE_SECURITY_"));
            assert!(!code.contains('/') && !code.contains('\\'));
        }
    }

    /// POSIX supervisors prove privacy from `uid` and mode bits themselves, so
    /// the helper refuses rather than answering with a check it cannot make.
    #[cfg(not(windows))]
    #[test]
    fn a_posix_helper_refuses_the_windows_only_commands() {
        assert_eq!(secure_directory("/state/one").unwrap_err().code, UNSUPPORTED);
        assert_eq!(verify_owner_only("/state/one").unwrap_err().code, UNSUPPORTED);
    }

    /// On Windows the directory the helper just secured must verify, and a
    /// directory it never touched must not.
    #[cfg(windows)]
    #[test]
    fn a_secured_directory_verifies_and_an_untouched_one_does_not() {
        let root = std::env::temp_dir().join(format!("nessie-state-{}", std::process::id()));
        let secured = root.join("secured");
        let untouched = root.join("untouched");
        std::fs::create_dir_all(&untouched).expect("the test directory must be creatable");

        secure_directory(secured.to_str().expect("a UTF-8 test path")).expect("securing succeeds");
        verify_owner_only(secured.to_str().expect("a UTF-8 test path")).expect("it verifies");
        assert_eq!(
            verify_owner_only(untouched.to_str().expect("a UTF-8 test path")).unwrap_err().code,
            REJECTED,
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
