use std::path::PathBuf;

use agenvo_core::{
    MessageBodyInput, build_room_operator, hear, join_message_body, parse_after,
    parse_message_body_inputs, say, to_jsonl,
};
use clap::{Parser, Subcommand};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Parser)]
#[command(version, about = "A local temporary agent room conversation log")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Append a message to a room.
    Say {
        /// Room path used as the conversation log directory.
        room_path: String,

        /// Speaker name within this room.
        #[arg(long = "as")]
        speaker: String,

        /// Body text, @path, @-, or - for stdin. Can be repeated.
        #[arg(short = 'b', long)]
        body: Vec<String>,

        /// Read a body chunk from a file. Can be repeated.
        #[arg(short = 'f', long)]
        file: Vec<PathBuf>,

        /// Read a body chunk from stdin.
        #[arg(long)]
        stdin: bool,

        /// Positional body text.
        #[arg(value_name = "MESSAGE", num_args = 0..)]
        message: Vec<String>,
    },

    /// Read messages from other speakers.
    Hear {
        /// Room path used as the conversation log directory.
        room_path: String,

        /// Listener speaker name within this room.
        #[arg(long = "as")]
        speaker: String,

        /// Return only messages with id greater than this UUIDv7.
        #[arg(long)]
        after: Option<String>,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Say {
            room_path,
            speaker,
            body,
            file,
            stdin,
            message,
        } => {
            let inputs = parse_message_body_inputs(&message, &body, &file, stdin)?;
            let body = read_body(&inputs).await?;
            let room = build_room_operator(&room_path)?;
            let message = say(&room, &speaker, body).await?;
            let mut stdout = tokio::io::stdout();
            stdout
                .write_all(serde_json::to_string(&message)?.as_bytes())
                .await?;
            stdout.write_all(b"\n").await?;
        }
        Command::Hear {
            room_path,
            speaker,
            after,
        } => {
            let after = after.as_deref().map(parse_after).transpose()?;
            let room = build_room_operator(&room_path)?;
            let heard = hear(&room, &speaker, after).await?;
            let mut stdout = tokio::io::stdout();
            stdout.write_all(to_jsonl(&heard)?.as_bytes()).await?;
        }
    }

    Ok(())
}

async fn read_body(inputs: &[MessageBodyInput]) -> anyhow::Result<String> {
    let mut chunks = Vec::with_capacity(inputs.len());

    for input in inputs {
        let chunk = match input {
            MessageBodyInput::Text(value) => value.clone(),
            MessageBodyInput::File(path) => tokio::fs::read_to_string(path).await?,
            MessageBodyInput::Stdin => {
                let mut body = String::new();
                tokio::io::stdin().read_to_string(&mut body).await?;
                body
            }
        };
        chunks.push(chunk);
    }

    Ok(join_message_body(chunks))
}
