//! Adding and removing the named folders an executor may read.
//!
//! Like the permitted-command grammar, this is a *pre*-check so the reach
//! surface can refuse in words rather than in an exit status.
//! `assertExecutorWorkspaceFolders` in the CLI decides for real — the grammar,
//! the duplicate and nesting rules, and whether a path is an ordinary directory
//! at all — and its answer is the one that lands in the policy.

use crate::description::Folder;

/// `EXECUTOR_WORKSPACE_FOLDER_MAXIMUM` in packages/schemas/src/executor.ts.
pub const MAXIMUM_COUNT: usize = 16;
/// `EXECUTOR_WORKSPACE_FOLDER_NAME_MAXIMUM_LENGTH`.
pub const MAXIMUM_NAME_LENGTH: usize = 40;
/// `EXECUTOR_RESERVED_WORKSPACE_FOLDER_NAMES`. Windows turns these basenames
/// into devices wherever a path is opened, and a reviewed policy has to stay
/// legal on the next machine that loads it.
pub const RESERVED_NAMES: &[&str] = &[
    "aux", "con", "nul", "prn", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
pub const FALLBACK_NAME: &str = "workspace";

pub const NAME_REFUSAL: &str =
    "A workspace folder name is 1 to 40 lowercase letters, digits and interior \
     hyphens. It starts every path an agent writes, so it carries no slash, no dot and no case.";

/// `EXECUTOR_WORKSPACE_FOLDER_NAME_PATTERN`: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`.
pub fn name_is_legal(value: &str) -> bool {
    if value.is_empty() || value.len() > MAXIMUM_NAME_LENGTH {
        return false;
    }
    if RESERVED_NAMES.contains(&value) {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    let Some(last) = value.chars().last() else { return false };
    if first == '-' || last == '-' {
        return false;
    }
    value
        .chars()
        .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
}

/// The name a chosen directory gets, derived the way
/// `deriveExecutorWorkspaceFolderName` derives it, so the name a person is
/// offered here is the name the CLI would pick. The derivation is total:
/// anything the grammar refuses becomes `workspace`.
pub fn derived_name(path: &str) -> String {
    let normalised = path.replace('\\', "/");
    let basename = std::path::Path::new(&normalised)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(FALLBACK_NAME);
    let mut hyphenated = String::new();
    let mut pending_hyphen = false;
    for character in basename.to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_hyphen && !hyphenated.is_empty() {
                hyphenated.push('-');
            }
            pending_hyphen = false;
            hyphenated.push(character);
        } else {
            pending_hyphen = true;
        }
    }
    let derived = hyphenated.chars().take(MAXIMUM_NAME_LENGTH).collect::<String>();
    if name_is_legal(&derived) { derived } else { FALLBACK_NAME.to_owned() }
}

/// Validates adding one folder to an existing list. The caller may supply a
/// name or ask for the derived one.
pub fn validate_adding(
    path: &str,
    requested_name: Option<&str>,
    existing: &[Folder],
) -> Result<Vec<Folder>, String> {
    let trimmed = path.trim();
    if !std::path::Path::new(trimmed).is_absolute() {
        return Err("A workspace folder is an absolute path on this computer.".to_owned());
    }
    let name = requested_name
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_owned())
        .unwrap_or_else(|| derived_name(trimmed));
    if !name_is_legal(&name) {
        return Err(NAME_REFUSAL.to_owned());
    }
    if existing.len() + 1 > MAXIMUM_COUNT {
        return Err(format!("An executor reaches at most {MAXIMUM_COUNT} folders."));
    }
    if existing.iter().any(|folder| folder.name == name) {
        return Err(format!(
            "This executor already reaches a folder named {name}. Two folders with one name \
             would make every path starting with it ambiguous."
        ));
    }
    for folder in existing {
        if contains(&folder.path, trimmed) || contains(trimmed, &folder.path) {
            return Err(if folder.path == trimmed {
                format!("This executor already reaches {trimmed}, as {}.", folder.name)
            } else {
                format!(
                    "{trimmed} and {} contain one another. A file inside both would have two \
                     workspace paths, so only one of them can be a folder.",
                    folder.path
                )
            });
        }
    }
    let mut folders = existing.to_owned();
    folders.push(Folder { name, path: trimmed.to_owned() });
    folders.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(folders)
}

/// Removing the last folder is refused: an executor paired against nothing can
/// read nothing, and the CLI refuses an empty list too.
pub fn validate_removing(name: &str, existing: &[Folder]) -> Result<Vec<Folder>, String> {
    let remaining: Vec<Folder> = existing.iter().filter(|folder| folder.name != name).cloned().collect();
    if remaining.len() == existing.len() {
        return Err(format!("{name} is not one of this executor's folders."));
    }
    if remaining.is_empty() {
        return Err(
            "An executor reaches at least one folder. Add the folder it should read before \
             removing this one."
                .to_owned(),
        );
    }
    Ok(remaining)
}

fn contains(outer: &str, inner: &str) -> bool {
    let outer_with_separator = if outer.ends_with('/') || outer.ends_with('\\') {
        outer.to_owned()
    } else {
        format!("{outer}/")
    };
    outer == inner || inner.starts_with(&outer_with_separator)
}

#[cfg(test)]
mod tests {
    use super::{derived_name, name_is_legal, validate_adding, validate_removing, Folder};

    fn folder(name: &str, path: &str) -> Folder {
        Folder { name: name.to_owned(), path: path.to_owned() }
    }

    #[test]
    fn legal_names_match_the_schema_pattern() {
        assert!(name_is_legal("nessie"));
        assert!(name_is_legal("nessie-workspace"));
        assert!(name_is_legal("a1"));
        assert!(!name_is_legal(""));
        assert!(!name_is_legal("-nessie"));
        assert!(!name_is_legal("nessie-"));
        assert!(!name_is_legal("nessie.workspace"));
        assert!(!name_is_legal("Nessie"));
        assert!(!name_is_legal("con"));
        assert!(!name_is_legal(&"a".repeat(41)));
    }

    #[test]
    fn derived_name_turns_a_basename_into_a_legal_name() {
        assert_eq!(derived_name("/home/person/Nessie Workspace"), "nessie-workspace");
        assert_eq!(derived_name("/home/person/work"), "work");
        assert_eq!(derived_name("/weird/weird--name"), "weird-name");
    }

    #[test]
    fn adding_requires_an_absolute_path() {
        assert!(validate_adding("work", None, &[]).is_err());
        assert!(validate_adding("./work", None, &[]).is_err());
        assert!(validate_adding("/home/person/work", None, &[]).is_ok());
        // On Windows the same check accepts a drive-letter path; on this macOS
        // host `std::path::is_absolute` does not, so the assertion is gated.
        #[cfg(windows)]
        assert!(validate_adding("C:\\Users\\person\\work", None, &[]).is_ok());
    }

    #[test]
    fn duplicate_names_and_nesting_are_refused() {
        let existing = vec![folder("nessie", "/home/person/nessie")];
        assert!(validate_adding("/home/person/nessie", None, &existing).is_err());
        assert!(validate_adding("/home/person/nessie/src", None, &existing).is_err());
    }

    #[test]
    fn removing_the_last_folder_is_refused() {
        let existing = vec![folder("nessie", "/home/person/nessie")];
        assert!(validate_removing("nessie", &existing).is_err());
        assert!(validate_removing("missing", &existing).is_err());
    }
}
