use std::path::PathBuf;

use jiff::Timestamp;
use opendal::services;
use opendal::{ErrorKind, Operator};
use serde::{Deserialize, Serialize};
use uuid::{Uuid, Version};

pub const MESSAGE_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub version: u8,
    pub id: String,
    pub speaker: String,
    pub created_at: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeardMessage {
    pub id: Uuid,
    pub message: Message,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MessageBodyInput {
    Text(String),
    File(PathBuf),
    Stdin,
}

#[derive(Debug, thiserror::Error)]
pub enum AgenvoError {
    #[error("speaker must not be empty")]
    EmptySpeaker,

    #[error("speaker must contain at least one path-safe character: A-Z, a-z, 0-9, '_' or '-'")]
    UnsafeSpeaker,

    #[error("message id must be a UUIDv7: {0}")]
    InvalidMessageId(String),

    #[error("message body is required; pass positional text, --body/-b, --file/-f, or --stdin")]
    MissingMessageBody,

    #[error("message body can read stdin only once")]
    DuplicateStdinBody,

    #[error("OpenDAL operation failed")]
    Storage(#[from] opendal::Error),

    #[error("JSON operation failed")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, AgenvoError>;

pub fn build_room_operator(room_path: &str) -> Result<Operator> {
    if is_opendal_uri(room_path) {
        opendal::init_default_registry();
        return Ok(Operator::from_uri(room_path)?);
    }

    let builder = services::Fs::default().root(room_path);
    Ok(Operator::new(builder)?.finish())
}

pub fn parse_message_body_inputs(
    positional: &[String],
    body: &[String],
    files: &[PathBuf],
    stdin: bool,
) -> Result<Vec<MessageBodyInput>> {
    let mut inputs = Vec::new();

    if !positional.is_empty() {
        inputs.push(MessageBodyInput::Text(positional.join(" ")));
    }

    inputs.extend(body.iter().map(|value| parse_message_body_value(value)));
    inputs.extend(files.iter().cloned().map(MessageBodyInput::File));

    if stdin {
        inputs.push(MessageBodyInput::Stdin);
    }

    if inputs.is_empty() {
        return Err(AgenvoError::MissingMessageBody);
    }

    let stdin_count = inputs
        .iter()
        .filter(|input| matches!(input, MessageBodyInput::Stdin))
        .count();
    if stdin_count > 1 {
        return Err(AgenvoError::DuplicateStdinBody);
    }

    Ok(inputs)
}

pub fn join_message_body(chunks: impl IntoIterator<Item = String>) -> String {
    chunks.into_iter().collect::<Vec<_>>().join("\n")
}

pub async fn say(room: &Operator, speaker: &str, body: impl Into<String>) -> Result<Message> {
    let safe_speaker = sanitize_speaker(speaker)?;
    let id = Uuid::now_v7();
    let id_text = id.hyphenated().to_string();
    let message = Message {
        version: MESSAGE_VERSION,
        id: id_text.clone(),
        speaker: speaker.to_owned(),
        created_at: Timestamp::now().to_string(),
        body: body.into(),
    };
    let path = format!("{id_text}.{safe_speaker}.json");
    let payload = serde_json::to_vec(&message)?;

    room.write_with(&path, payload).if_not_exists(true).await?;

    Ok(message)
}

pub async fn hear(
    room: &Operator,
    listener: &str,
    after: Option<Uuid>,
) -> Result<Vec<HeardMessage>> {
    validate_speaker(listener)?;

    let entries = match room.list("").await {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };

    let mut heard = Vec::new();

    for entry in entries {
        let Some(id) = message_id_from_path(entry.path()) else {
            continue;
        };

        if after.is_some_and(|after| id <= after) {
            continue;
        }

        let payload = match room.read(entry.path()).await {
            Ok(payload) => payload,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) if err.kind() == ErrorKind::IsADirectory => continue,
            Err(err) => return Err(err.into()),
        };

        let message: Message = match serde_json::from_slice(payload.to_bytes().as_ref()) {
            Ok(message) => message,
            Err(_) => continue,
        };

        if !is_valid_stored_message(&message, id) {
            continue;
        }

        if message.speaker == listener {
            continue;
        }

        heard.push(HeardMessage { id, message });
    }

    heard.sort_by_key(|heard| heard.id);
    Ok(heard)
}

pub fn parse_after(value: &str) -> Result<Uuid> {
    let id = Uuid::parse_str(value).map_err(|_| AgenvoError::InvalidMessageId(value.to_owned()))?;
    if id.get_version() != Some(Version::SortRand) {
        return Err(AgenvoError::InvalidMessageId(value.to_owned()));
    }
    Ok(id)
}

pub fn to_jsonl(messages: &[HeardMessage]) -> Result<String> {
    let mut output = String::new();
    for heard in messages {
        output.push_str(&serde_json::to_string(&heard.message)?);
        output.push('\n');
    }
    Ok(output)
}

fn is_opendal_uri(value: &str) -> bool {
    value.contains("://")
}

fn parse_message_body_value(value: &str) -> MessageBodyInput {
    if value == "-" || value == "@-" {
        return MessageBodyInput::Stdin;
    }

    if let Some(path) = value.strip_prefix('@') {
        return MessageBodyInput::File(PathBuf::from(path));
    }

    MessageBodyInput::Text(value.to_owned())
}

fn validate_speaker(speaker: &str) -> Result<()> {
    if speaker.is_empty() {
        return Err(AgenvoError::EmptySpeaker);
    }
    Ok(())
}

fn sanitize_speaker(speaker: &str) -> Result<String> {
    validate_speaker(speaker)?;

    let safe: String = speaker
        .chars()
        .filter(|&ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        .take(64)
        .collect();

    if safe.is_empty() {
        return Err(AgenvoError::UnsafeSpeaker);
    }

    Ok(safe)
}

fn message_id_from_path(path: &str) -> Option<Uuid> {
    let file_name = path.trim_end_matches('/');
    if file_name.contains('/') {
        return None;
    }

    let (id_text, suffix) = file_name.split_once('.')?;

    if suffix.is_empty() || !suffix.ends_with(".json") {
        return None;
    }

    let safe_speaker = suffix.strip_suffix(".json")?;
    if safe_speaker.is_empty()
        || !safe_speaker
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }

    let id = Uuid::parse_str(id_text).ok()?;
    if id.get_version() == Some(Version::SortRand) {
        Some(id)
    } else {
        None
    }
}

fn is_valid_stored_message(message: &Message, file_id: Uuid) -> bool {
    if message.version != MESSAGE_VERSION {
        return false;
    }

    let Ok(json_id) = Uuid::parse_str(&message.id) else {
        return false;
    };

    json_id == file_id && json_id.get_version() == Some(Version::SortRand)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_speaker_for_file_suffix() {
        assert_eq!(sanitize_speaker("reviewer").unwrap(), "reviewer");
        assert_eq!(sanitize_speaker("Claude Code").unwrap(), "ClaudeCode");
        assert_eq!(sanitize_speaker("../bad").unwrap(), "bad");
        assert!(sanitize_speaker("///").is_err());
    }

    #[test]
    fn detects_opendal_uri_room_paths() {
        assert!(is_opendal_uri("s3://bucket/path/to/room"));
        assert!(is_opendal_uri("fs:///tmp/agenvo-room"));
        assert!(is_opendal_uri("file:///tmp/agenvo-room"));
        assert!(!is_opendal_uri("/tmp/agenvo-room"));
        assert!(!is_opendal_uri("relative/agenvo-room"));
    }

    #[test]
    fn builds_s3_room_operator_from_uri() {
        build_room_operator(
            "s3://example-bucket/path/to/room?region=us-east-1&skip_signature=true&disable_config_load=true",
        )
        .unwrap();
    }

    #[test]
    fn parses_message_body_inputs_from_supported_sources() {
        let positional = vec!["hello".to_owned(), "world".to_owned()];
        let body = vec!["inline".to_owned(), "@msg.md".to_owned(), "-".to_owned()];
        let files = vec![PathBuf::from("extra.md")];

        let inputs = parse_message_body_inputs(&positional, &body, &files, false).unwrap();

        assert_eq!(
            inputs,
            vec![
                MessageBodyInput::Text("hello world".to_owned()),
                MessageBodyInput::Text("inline".to_owned()),
                MessageBodyInput::File(PathBuf::from("msg.md")),
                MessageBodyInput::Stdin,
                MessageBodyInput::File(PathBuf::from("extra.md")),
            ]
        );
    }

    #[test]
    fn parses_at_dash_as_stdin_body_input() {
        let body = vec!["@-".to_owned()];

        let inputs = parse_message_body_inputs(&[], &body, &[], false).unwrap();

        assert_eq!(inputs, vec![MessageBodyInput::Stdin]);
    }

    #[test]
    fn rejects_missing_message_body_input() {
        assert!(matches!(
            parse_message_body_inputs(&[], &[], &[], false),
            Err(AgenvoError::MissingMessageBody)
        ));
    }

    #[test]
    fn rejects_duplicate_stdin_body_inputs() {
        let body = vec!["-".to_owned()];

        assert!(matches!(
            parse_message_body_inputs(&[], &body, &[], true),
            Err(AgenvoError::DuplicateStdinBody)
        ));
    }

    #[test]
    fn joins_message_body_chunks_with_newlines() {
        let body = join_message_body(["first".to_owned(), "second".to_owned()]);

        assert_eq!(body, "first\nsecond");
    }

    #[test]
    fn parses_only_uuidv7_cursor() {
        let id = Uuid::now_v7().hyphenated().to_string();
        assert_eq!(parse_after(&id).unwrap().hyphenated().to_string(), id);
        assert!(parse_after("00000000-0000-0000-0000-000000000000").is_err());
        assert!(parse_after("not-a-uuid").is_err());
    }

    #[test]
    fn accepts_only_valid_message_object_names() {
        let id = Uuid::now_v7().hyphenated().to_string();
        assert!(message_id_from_path(&format!("{id}.author.json")).is_some());
        assert!(message_id_from_path(&format!("nested/{id}.author.json")).is_none());
        assert!(message_id_from_path(&format!("{id}.bad/name.json")).is_none());
        assert!(message_id_from_path(&format!("{id}.bad.suffix.json")).is_none());
        assert!(message_id_from_path("not-a-uuid.author.json").is_none());
    }

    #[test]
    fn validates_stored_message_id_against_filename() {
        let id = Uuid::now_v7();
        let message = Message {
            version: MESSAGE_VERSION,
            id: id.to_string(),
            speaker: "author".to_owned(),
            created_at: "2026-07-03T12:02:15Z".to_owned(),
            body: "body".to_owned(),
        };

        assert!(is_valid_stored_message(&message, id));
        assert!(!is_valid_stored_message(&message, Uuid::now_v7()));
    }
}
