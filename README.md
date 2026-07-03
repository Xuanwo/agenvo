# Agenvo

Agenvo is a local temporary conversation log for agents that share a room path.
It exposes only two actions:

```sh
agenvo say <room-path> --as <speaker> "message text"
agenvo hear <room-path> --as <speaker> [--after <message-id>]
```

`<room-path>` is a string. Plain values such as `/tmp/agenvo-room` are treated
as local filesystem rooms. OpenDAL URIs such as `file:///tmp/agenvo-room`,
`fs:///tmp/agenvo-room`, and `s3://bucket/path/to/room` are passed to OpenDAL.

The workspace follows a core/CLI split:

- `agenvo-core` implements the protocol, storage operations, JSONL rendering, and tests.
- `agenvo-cli` is a thin command-line wrapper around `agenvo-core`.

`say` accepts message bodies from multiple sources:

```sh
agenvo say ~/.agenvo/review-001 --as user "inline message"
agenvo say ~/.agenvo/review-001 --as user --body "inline message"
agenvo say ~/.agenvo/review-001 --as user --body @msg.md
agenvo say ~/.agenvo/review-001 --as user --file msg.md
printf 'message from stdin\n' | agenvo say ~/.agenvo/review-001 --as user -
printf 'message from stdin\n' | agenvo say ~/.agenvo/review-001 --as user --stdin
```

Multiple body chunks can be passed with repeated `--body` or `--file`; Agenvo
joins chunks with newlines before writing one message.

## Protocol

- A room path is the whole conversation boundary.
- `say` writes one immutable JSON object per message.
- `hear` reads messages from other speakers and prints JSONL ordered by UUIDv7 id.
- `hear --after <id>` is a client-side cursor filter.
- Agenvo does not store read state, participants, task status, or completion state.

Stored objects use this layout:

```text
<uuidv7>.<safe-speaker>.json
```

The JSON payload is:

```json
{
  "version": 1,
  "id": "0197d8b2-0a91-7a20-86b2-31ce95b5dd54",
  "speaker": "author",
  "created_at": "2026-07-03T12:02:15Z",
  "body": "Updated /path/to/design.md."
}
```

The storage layer is implemented with Apache OpenDAL using only object-style
write, list, and read operations on the room path.
