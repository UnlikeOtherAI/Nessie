//! The grammar a permitted command has to satisfy, restated so the tools
//! surface can refuse in words a person can act on instead of showing the
//! CLI's exit status. It is a *pre*-check, never the decision: `configure`
//! runs `parseExecutorCommandPattern` (packages/schemas/src/executor.ts) over
//! the same list and its answer is the one that lands in the policy.

/// `EXECUTOR_COMMAND_ALLOWLIST_MAXIMUM` in packages/schemas/src/executor.ts.
pub const MAXIMUM_COUNT: usize = 64;
/// `EXECUTOR_COMMAND_PATTERN_MAXIMUM_LENGTH`.
pub const MAXIMUM_LENGTH: usize = 512;
const MAXIMUM_ARGUMENT_LENGTH: usize = 4_096;
const WILDCARD: &str = "*";
const SHELLS: &[&str] = &["bash", "dash", "fish", "ksh", "sh", "zsh"];

pub const GRAMMAR_REFUSAL: &str =
    "A permitted command is a program the guest resolves through its fixed PATH, \
     optionally followed by arguments and a trailing \"*\" — for example \"git *\" or \"npm run *\". \
     Paths, shells and a leading \"*\" are refused, at most 64 entries.";

/// The canonical spelling of an entry, or `None` when it is not one. Mirrors
/// `parseExecutorCommandPattern`: runs of whitespace are a typo rather than
/// an argument, so normalising here means re-typing the same rule with two
/// spaces is not a new revision for somebody to review.
pub fn normalise(entry: &str) -> Option<String> {
    let trimmed = entry.trim();
    if trimmed.is_empty() || trimmed.len() > MAXIMUM_LENGTH || trimmed.contains('\0') {
        return None;
    }
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    let program = *tokens.first()?;
    if program.is_empty()
        || program.len() > 256
        || program.contains('/')
        || program.contains('\\')
        || SHELLS.contains(&program)
    {
        return None;
    }
    let permits_further_arguments = tokens.last().copied() == Some(WILDCARD);
    let argument_prefix = if tokens.len() <= 1 {
        &[][..]
    } else if permits_further_arguments {
        &tokens[1..tokens.len() - 1]
    } else {
        &tokens[1..]
    };
    if std::iter::once(program)
        .chain(argument_prefix.iter().copied())
        .any(|token| token.contains(WILDCARD))
    {
        return None;
    }
    if argument_prefix.iter().any(|token| token.len() > MAXIMUM_ARGUMENT_LENGTH) {
        return None;
    }
    Some(
        std::iter::once(program)
            .chain(argument_prefix.iter().copied())
            .chain(if permits_further_arguments { Some(WILDCARD) } else { None })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

/// Validates adding one command to an existing list.
pub fn validate_adding(entry: &str, existing: &[String]) -> Result<Vec<String>, String> {
    let command = normalise(entry).ok_or_else(|| GRAMMAR_REFUSAL.to_owned())?;
    if existing.iter().any(|item| item == &command) {
        return Err(format!("{command} is already a permitted command."));
    }
    if existing.len() + 1 > MAXIMUM_COUNT {
        return Err(GRAMMAR_REFUSAL.to_owned());
    }
    let mut programs = existing.to_owned();
    programs.push(command);
    programs.sort();
    Ok(programs)
}

/// Validates removing one command. If `command.run` is enabled, the list must
/// never become empty, because an operation that can never succeed is a
/// misconfiguration, not a policy.
pub fn validate_removing(
    command: &str,
    existing: &[String],
    command_run_enabled: bool,
) -> Result<Vec<String>, String> {
    let remaining: Vec<String> = existing.iter().filter(|item| item.as_str() != command).cloned().collect();
    if remaining.len() == existing.len() {
        return Err(format!("{command} is not a permitted command."));
    }
    if command_run_enabled && remaining.is_empty() {
        return Err(
            "Name at least one permitted command before enabling command.run. Turn off \
             command.run in Nessie first, or keep one command on the list."
                .to_owned(),
        );
    }
    Ok(remaining)
}

#[cfg(test)]
mod tests {
    use super::{normalise, validate_adding, validate_removing};

    #[test]
    fn normalise_accepts_programs_and_argument_prefixes_with_a_trailing_wildcard() {
        assert_eq!(normalise("git *"), Some("git *".to_owned()));
        assert_eq!(normalise("npm   run  *"), Some("npm run *".to_owned()));
        assert_eq!(normalise("node"), Some("node".to_owned()));
    }

    #[test]
    fn normalise_refuses_shells_misplaced_wildcards_and_path_in_the_program_position() {
        assert_eq!(normalise("/usr/bin/git *"), None);
        assert_eq!(normalise("bash *"), None);
        assert_eq!(normalise("*"), None);
        assert_eq!(normalise("git * log"), None);
        assert_eq!(normalise(""), None);
        // A slash in an argument is allowed by the shared schema; only the
        // program position must resolve through the guest's fixed PATH.
        assert_eq!(normalise("git /etc/passwd"), Some("git /etc/passwd".to_owned()));
    }

    #[test]
    fn adding_refuses_duplicates_and_overflow() {
        let existing = vec!["git *".to_owned()];
        assert!(validate_adding("git *", &existing).is_err());
        assert_eq!(validate_adding("node", &existing).unwrap(), vec!["git *".to_owned(), "node".to_owned()]);
    }

    #[test]
    fn removing_the_last_command_is_refused_when_command_run_is_enabled() {
        let existing = vec!["git *".to_owned()];
        assert!(validate_removing("git *", &existing, true).is_err());
        assert_eq!(validate_removing("git *", &existing, false).unwrap(), Vec::<String>::new());
    }
}
