//! Reading the invitation a person copied out of **Agents → Executors**.
//!
//! That page offers one thing to copy: the `nessie-executor pair …` command,
//! carrying `--api`, `--enrollment` and `--challenge`. Somebody pasting a link
//! instead is reading the same two values off the same page, so both shapes are
//! accepted and nothing else is — this parses our own structured output, and a
//! text that carries neither pair of values is refused rather than guessed at.

const PRODUCTION_API_BASE_URL: &str = "https://api.nessie.works";

const DEVELOPMENT_API_BASE_URL: &str = "http://127.0.0.1:5454";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    pub api_base_url: String,
    pub challenge: String,
    pub enrollment_id: String,
}

/// The API this build pairs with when the invitation does not name one. The
/// service validates the value again and refuses anything else, so this is a
/// convenience, never an authorization.
fn default_api_base_url() -> &'static str {
    if cfg!(debug_assertions) {
        DEVELOPMENT_API_BASE_URL
    } else {
        PRODUCTION_API_BASE_URL
    }
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|rest| rest.strip_suffix('\'')))
        .unwrap_or(value)
}

/// `--flag value` and `--flag=value` both appear in things people paste.
fn flag_value(tokens: &[&str], flag: &str) -> Option<String> {
    let prefix = format!("{flag}=");
    for (index, token) in tokens.iter().enumerate() {
        if let Some(inline) = token.strip_prefix(prefix.as_str()) {
            return Some(unquote(inline).to_owned());
        }
        if *token == flag {
            let next = tokens.get(index + 1)?;
            if next.starts_with("--") {
                return None;
            }
            return Some(unquote(next).to_owned());
        }
    }
    None
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn query_value(text: &str, key: &str) -> Option<String> {
    let query = text.split_once('?')?.1;
    query
        .split(['&', '#'])
        .find_map(|pair| pair.split_once('=').filter(|(name, _)| *name == key))
        .map(|(_, value)| percent_decode(value))
}

/// Accepts the pairing command or the invitation link, and refuses anything
/// that carries neither. The values themselves are validated by the service,
/// which is the only place that decides what a well-formed enrollment id is.
pub fn parse_invitation(text: &str) -> Result<Invitation, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Paste the invitation from Agents → Executors in Nessie.".to_owned());
    }
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let enrollment_id = flag_value(&tokens, "--enrollment")
        .or_else(|| query_value(text, "enrollmentId"))
        .filter(|value| !value.is_empty());
    let challenge = flag_value(&tokens, "--challenge")
        .or_else(|| query_value(text, "challenge"))
        .filter(|value| !value.is_empty());
    let (Some(enrollment_id), Some(challenge)) = (enrollment_id, challenge) else {
        return Err(
            "That is not a Nessie executor invitation. Copy the pairing command or link from \
             Agents → Executors."
                .to_owned(),
        );
    };
    Ok(Invitation {
        api_base_url: flag_value(&tokens, "--api")
            .or_else(|| query_value(text, "api"))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_api_base_url().to_owned()),
        challenge,
        enrollment_id,
    })
}

#[cfg(test)]
mod tests {
    use super::{default_api_base_url, parse_invitation};

    const ENROLLMENT: &str = "3f1c9a2e-0000-4000-8000-000000000001";
    const CHALLENGE: &str = "Zm9vYmFyLWNoYWxsZW5nZQ";

    /// Exactly what the Executors page renders for copying today.
    #[test]
    fn reads_the_pairing_command_the_executors_page_offers() {
        let command = format!(
            "nessie-executor pair --api https://api.nessie.works --state-dir \
             \"$HOME/.nessie-executor\" --workspace \"/absolute/read-only/workspace\" \
             --enrollment {ENROLLMENT} --challenge {CHALLENGE}",
        );
        let invitation = parse_invitation(&command).expect("the pairing command must parse");
        assert_eq!(invitation.enrollment_id, ENROLLMENT);
        assert_eq!(invitation.challenge, CHALLENGE);
        assert_eq!(invitation.api_base_url, "https://api.nessie.works");
    }

    #[test]
    fn reads_an_invitation_link_with_the_same_two_values() {
        let invitation = parse_invitation(&format!(
            "https://app.nessie.works/agents/executors?enrollmentId={ENROLLMENT}&challenge={CHALLENGE}%3D",
        ))
        .expect("the invitation link must parse");
        assert_eq!(invitation.enrollment_id, ENROLLMENT);
        // Percent-encoded base64 padding survives: a challenge that lost its
        // `=` would be rejected by the API with nothing to explain it.
        assert_eq!(invitation.challenge, format!("{CHALLENGE}="));
        assert_eq!(invitation.api_base_url, default_api_base_url());
    }

    #[test]
    fn accepts_the_equals_form_and_quoted_values() {
        let invitation = parse_invitation(&format!(
            "pair --enrollment={ENROLLMENT} --challenge=\"{CHALLENGE}\"",
        ))
        .expect("the equals form must parse");
        assert_eq!(invitation.enrollment_id, ENROLLMENT);
        assert_eq!(invitation.challenge, CHALLENGE);
    }

    #[test]
    fn refuses_anything_that_is_not_an_invitation() {
        for text in [
            "",
            "   ",
            "hello",
            // Half an invitation is not one; pairing with a missing challenge
            // would fail at the API with nothing to explain it.
            &format!("pair --enrollment {ENROLLMENT}"),
            &format!("pair --challenge {CHALLENGE}"),
            // A flag whose value is the next flag has no value at all.
            &format!("pair --enrollment --challenge {CHALLENGE}"),
        ] {
            assert!(parse_invitation(text).is_err(), "text {text:?} must be refused");
        }
    }
}
