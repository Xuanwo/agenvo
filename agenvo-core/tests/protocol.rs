use agenvo_core::{build_room_operator, hear, parse_after, say, to_jsonl};
use serde_json::Value;
use uuid::{Uuid, Version};

fn temp_room(name: &str) -> std::path::PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("agenvo-test-{name}-{}", Uuid::now_v7()));
    path
}

#[tokio::test]
async fn hear_missing_room_returns_empty_success() {
    let room = temp_room("missing");
    let room = build_room_operator(&room.to_string_lossy()).unwrap();

    let heard = hear(&room, "reviewer", None).await.unwrap();

    assert!(heard.is_empty());
}

#[tokio::test]
async fn say_creates_room_and_hear_reads_other_speakers_as_jsonl() {
    let room_path = temp_room("roundtrip");
    let room = build_room_operator(&room_path.to_string_lossy()).unwrap();

    let said = say(&room, "user", "hello from user\n").await.unwrap();
    let id = Uuid::parse_str(&said.id).unwrap();

    assert_eq!(id.get_version(), Some(Version::SortRand));
    assert_eq!(said.speaker, "user");
    assert_eq!(said.body, "hello from user\n");

    let heard = hear(&room, "reviewer", None).await.unwrap();
    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].message.id, said.id);
    assert_eq!(heard[0].message.speaker, "user");

    let jsonl = to_jsonl(&heard).unwrap();
    let lines: Vec<_> = jsonl
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["id"], said.id);

    let self_heard = hear(&room, "user", None).await.unwrap();
    assert!(self_heard.is_empty());

    let after_heard = hear(&room, "reviewer", Some(parse_after(&said.id).unwrap()))
        .await
        .unwrap();
    assert!(after_heard.is_empty());
}

#[tokio::test]
async fn file_uri_room_path_roundtrips() {
    let room_path = temp_room("file-uri");
    let room_uri = format!("file://{}", room_path.display());
    let room = build_room_operator(&room_uri).unwrap();

    say(&room, "author", "hello over file uri").await.unwrap();
    let heard = hear(&room, "reviewer", None).await.unwrap();

    assert_eq!(heard.len(), 1);
    assert_eq!(heard[0].message.speaker, "author");
    assert_eq!(heard[0].message.body, "hello over file uri");
}

#[tokio::test]
async fn hear_ignores_invalid_files_and_orders_by_uuid() {
    let room_path = temp_room("invalid-files");
    std::fs::create_dir_all(&room_path).unwrap();
    std::fs::write(room_path.join("README.md"), "ignore me").unwrap();
    std::fs::write(
        room_path.join(format!("{}.author.json", Uuid::now_v7())),
        "{",
    )
    .unwrap();
    let room = build_room_operator(&room_path.to_string_lossy()).unwrap();

    let first = say(&room, "author", "first").await.unwrap();
    let second = say(&room, "reviewer", "second").await.unwrap();

    let heard = hear(&room, "observer", None).await.unwrap();
    let ids: Vec<_> = heard
        .iter()
        .map(|heard| Uuid::parse_str(&heard.message.id).unwrap())
        .collect();

    assert_eq!(heard.len(), 2);
    assert_eq!(heard[0].message.id, first.id);
    assert_eq!(heard[1].message.id, second.id);
    assert!(ids[0] < ids[1]);
}
