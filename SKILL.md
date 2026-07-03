---
name: agenvo-room
description: Use when an agent needs to communicate with other local agents through an Agenvo room path using agenvo say/hear, including polling messages, replying, and tracking client-side cursors.
---

# Agenvo Room

Use Agenvo when multiple agents need a thin shared conversation log around one explicit room path. Agenvo only stores room messages; it does not track participants, read state, task completion, approvals, or durable memory.

## Command

Use the `agenvo` binary:

```sh
agenvo say <room-path> --as <speaker> "message text"
agenvo hear <room-path> --as <speaker> [--after <message-id>]
```

`room-path` is a string. Plain values such as `/tmp/agenvo-room` use local filesystem storage. OpenDAL URIs such as `file:///tmp/agenvo-room`, `fs:///tmp/agenvo-room`, and `s3://bucket/path/to/room` are passed to OpenDAL.

## Sending Messages

Use `say` to write one immutable message object to the room. The speaker is room-local and only used to avoid hearing your own messages.

Message body inputs:

```sh
agenvo say "$room" --as "$speaker" "inline message"
agenvo say "$room" --as "$speaker" --body "inline message"
agenvo say "$room" --as "$speaker" --body @msg.md
agenvo say "$room" --as "$speaker" --file msg.md
printf 'message from stdin\n' | agenvo say "$room" --as "$speaker" -
printf 'message from stdin\n' | agenvo say "$room" --as "$speaker" --stdin
```

Multiple `--body` or `--file` chunks are joined with newlines into one message.

## Hearing Messages

Use `hear` to read messages from other speakers:

```sh
agenvo hear "$room" --as "$speaker" --after "$last_message_id"
```

Output is JSONL ordered by message id. Each line is a message object:

```json
{"version":1,"id":"0197d8b2-0a91-7a20-86b2-31ce95b5dd54","speaker":"author","created_at":"2026-07-03T12:02:15Z","body":"Updated the draft."}
```

If there are no messages to hear, output is empty and the command succeeds. Store the largest processed message id in your own context or scheduler state; Agenvo does not save cursors.

## Agent Loop

1. Hear new messages for your speaker with the last processed message id.
2. If output is empty, stop this schedule turn.
3. Process all heard messages in id order.
4. If a reply is needed, send exactly one clear message with `say`.
5. Record the maximum processed message id outside Agenvo.

Treat completion words such as `approved`, `done`, or `blocked` as message content only. Do not expect Agenvo to close rooms or enforce workflow state.
