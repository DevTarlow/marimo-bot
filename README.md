<p align="center">
  <img src="./apps/desktop/public/marimo-logo.png" alt="Marimo Bot" width="180" />
</p>

<h1 align="center">Marimo Bot</h1>

<p align="center">A desktop AI assistant that works in a folder you choose.</p>

> [!WARNING]
> Marimo Bot is under construction. It changes often, and some changes are breaking: what one build saved, the next may rewrite or refuse. Keep your own copies of anything you care about.

I built Marimo Bot to sit on your computer and work inside a folder you choose. It can read and write the files there, remember what matters, and keep a few helpers, called bots, for the work you repeat.

So the app can read the files in a project without you copying them anywhere, and a chat you start in one folder stays with that folder.

It runs on your computer, not in a browser. There is no account with us. You bring the model: a service you already use, or a llama.cpp server on your own machine.

The chat window and the moss ball share one conversation, so a question you ask from the corner of the screen is waiting in the window when you open it, and the folder you were working in comes back with it.

<p align="center">
  <img src="./docs/screenshots/app-light.png" alt="The Marimo Bot window in light mode, with Marimo and Writer in the sidebar and a Space open." />
</p>

<p align="center">The main window in light mode.</p>

## The short version

- Work in a folder, not a chat that forgets where it is.
- Make bots for writing, research, code or whatever you repeat.
- Keep a memory that follows you between folders.
- Find a file by what it was about, not the exact words.
- Schedule a job and close the window.
- Ask the moss ball when you do not want the window.

## On this page

- [What it can do](#what-it-can-do)
- [Bots](#bots)
- [Memory](#memory)
- [Recall](#recall-find-by-meaning)
- [Dream-RSI](#dream-rsi)
- [Jobs](#jobs)
- [The companion](#the-companion)
- [Models and keys](#models-and-keys)
- [Privacy and control](#privacy-and-control)
- [Getting started](#getting-started)
- [Questions](#questions)
- [What is not finished](#what-is-not-finished)
- [Requirements](#requirements)

## What it can do

### The folder you work in

A Space is just a folder.

The app can read and write the files in it, and nowhere else. Load a folder and the app files every chat you start there under that Space.

Because the work happens in the folder you chose, it lands in the same place as the rest of your project, and you can open the files with the editor or tools you already use.

The Documents drawer lists the markdown files already in that folder. You can edit them there, and the bot sees your changes. If a bot writes a markdown file, it appears in the drawer.

If a file has changed while you had it open, the app will not overwrite it. It keeps your draft and asks which version wins.

The app refuses the save because a quiet overwrite would replace the version on disk, and it cannot know which one you meant to keep.

You can save a chat as a document, with the messages under the author's name.

The app writes a new file straight away, while overwriting one asks first.

### Bots

What kind of work do you repeat? A bot is for the work you do again and again.

A bot is a helper with its own name, instructions, tools, memory and chats. You can make one for writing, one for research, one for code.

Every bot has a Role and a Persona. The Role is the app's job description: what the bot is for and the rules every bot follows. The Persona is yours: its character, the job in your own words and how you want it to talk to you. The app reads the Persona after the Role, so your words win on tone, but the Persona cannot give a bot a tool it was not given, because the tool list is separate and the operating rules come last. The app can restore the Role, but it will not reset the Persona on its own.

There are three ways to make one.

1. Start from a role. Pick Writer, Marketer, Researcher, Coder, Analyst or Personal assistant. You get a name, a Role, a first Persona and tools. Change the name if you like.
2. Build it step by step. Choose a role or start blank, name it, and pick what it can do.
3. Talk it through with Marimo. Marimo asks what the bot is for, drafts it and shows you a card. Change the name, the starter role or the Persona, then press Create. Nothing is made until you do.

All three end in the same place, so you can pick a starter role when one fits, build it step by step when you want to choose every part, or talk it through with Marimo when you would rather answer questions than fill in a form.

Bots sit at the top of the sidebar, and picking one shows its chats. Settings has its Role, Persona, tools and Space.

The icon can be one of five shipped pictures, or one you upload.

Several bots can share a chat, so type `@` to put a question to one of them. If you let it, Marimo Bot can hand work to a bot. The answer comes back in the same chat under the bot's name, and any approval is asked there.

Removing a bot asks first, and it takes the bot's chats, jobs and memory with it. Files it wrote in your Spaces stay, and the last bot stays too, because something has to answer.

### Long conversations

When a chat gets long, the app replaces the older part with a summary so the model can keep going, and the conversation keeps every message.

**Compact** in the `+` menu beside the message box does the same when you ask.

### Memory

A fact about you follows you between Spaces, while a note about how a project is set up stays with that project, and the app keeps them apart.

What does it remember? Settings lists every line and when it was written. If an answer is wrong, choose **Not quite**, and it records the correction and proposes it the next time the bot reads the chat.

Memory has a soft limit, so the bot is told when it gets close and can prune what no longer matters.

The memory file is plain markdown, so you can read it without the app.

### Recall: find by meaning

Use Recall when you remember what a file was about but not the words in it. Press `Ctrl+K`.

It uses EmbeddingGemma 2, a small model with 270 million parameters. The model turns a piece of text into a list of numbers, and the app compares those numbers so a search for the idea can find a file whose exact words you have forgotten. It runs on your processor.

Recall is off until you turn it on. The first time you turn it on, the app downloads the engine and the model it runs. The text model is 310 MB. The part that handles pictures, audio and video is another 555 MB, and you only need it for media search.

What does it search? You choose files, memory, past chats and media. When a Space is loaded, the index, a list of numbers the app can search, stays inside it.

What was it about? A result shows how close the match is and whether the file has changed since it was indexed.

After the download, Recall runs on your machine, so your searches stay local.

### Dream-RSI

Dream-RSI records how the bot decided: for each turn, it writes which tools the bot was offered, which it called, the arguments and the result. It keeps one file per chat.

Nothing is sent anywhere.

Dream-RSI is off by default, and the two settings are about how the bot searches. The exploration weight is how willing it is to try a tool it has not used before. The pruning threshold is when it stops offering a tool that keeps failing. The default prunes nothing.

Why would you want that? To compare settings on your own work instead of guessing.

The card also shows the replay command:

```bash
pnpm --filter @marimo/desktop replay:dream
```

The replay reads the recorded turns and tries other settings on them. It does not call a model or spend a token. It can show what a setting would have hidden, but it cannot show what would have happened next, because the bot chose each step from the result of the one before it, and a different setting changes that result.

### Jobs

What happens while the window is closed? A scheduled job keeps going.

Schedule a task, like a summary every morning. Closing the window does not quit the app. It stays in the tray, the small icon near your clock.

The sidebar has a switch called Keep jobs running when the app is closed. It installs a small background worker so a timer can wake it and run due jobs.

The worker is a small copy of the app that can run due jobs while the window is closed, and it takes turns with the app so the two never write to one chat at the same time.

Then it goes back to sleep until the next job is due.

To quit, use the tray menu.

### The companion

The moss ball is another way into the same conversation. It floats above your other windows with its own chat bar.

Settings lets you choose how long its answers are, how many messages float above it, whether it stays on top, and whether you can click through it to the window behind.

## Models and keys

No chat model is included, so you choose the service that answers.

- DeepSeek, Google Gemini, OpenCode Go or OpenRouter: an account and an API key. A key is a long password from the service.
- llama.cpp: a program that runs a model on your own machine. Give the app its address. It needs no key, and on your network nothing leaves it.

**Fetch Models** asks the service what it serves. Until you ask, the app lists the names it ships with.

Which model should a bot use? That is yours to decide: a model is a service and a name. The app stores both because the same name can mean different things at different services, which is why a bot can have its own model and a single chat can use another one.

### Connectors

A connector is a server you add in Settings. It can give a bot tools that live in another app or on another machine: a database, an issue tracker or a service on your network. MCP is the Model Context Protocol, a standard way for a tool server to describe what it can do.

Each bot has its own permissions, and a connector that is not ticked is not offered to that bot. The app stores a connector's token or password like a provider key, and the background worker can only use one stored as plain text, with your consent.

### Keys

Keys go in your operating system's password vault, the keychain, when there is one. A background job has no keychain, so the box in setup ("Let scheduled jobs use this key while the app is closed") stores the key as plain text instead. Leave it off unless you need a job to run while the app is closed. A key stored as plain text can be read by anything that can open the file. A machine without a keychain can only store a key as plain text.

## Privacy and control

Where do your words go? The answer depends on the service you chose: a local llama.cpp server keeps them on your machine or your network, while an online service gets them under your account.

The app's other network traffic comes from the things you ask for. A web search sends the query to DuckDuckGo. A connector talks to the server you set up. **Fetch Models** asks the provider what it serves. Recall downloads its engine and model once.

The app keeps its own data in one folder. On Linux that is `~/.config/Marimo Bot`. Your chats, the Spaces you loaded and your settings are there. Keys are in the keychain, except a key you let a background job read, which is in that folder instead.

But the app's own data is not your project, and the two live in different folders on purpose. A Space's files stay where you put them.

A command, or a save over a file that already exists, waits for your answer. The app writes a new file without asking. A scheduled job that hits an approval stays paused, and the request survives a restart.

Every tool the app offers is a switch in Settings. If a tool is off, the app does not offer it to the model at all.

Recall and Dream-RSI are off until you turn them on. Neither sends its record anywhere.

Reset Marimo Bot, at the bottom of Settings, erases the app's folder, switches off start-at-login and the job timer, and quits. There is no undo.

## Getting started

There is no public download yet. The Linux version builds to a single AppImage file you can run without installing it. The Windows and macOS installers are written but not built.

If you have the app, the first run is short.

1. Choose a model. Which service should answer? Pick a service, or point the app at a llama.cpp server. An online service needs an account and a key. **Fetch Models** asks it what it serves. Set this up later closes the flow.
2. Choose a Space. Pick a folder. The app can read and write there, and nowhere else. You can skip this.
3. Make a bot. Start from a role, build it step by step or talk to Marimo.
4. Make it yours. Pick an icon, and write its Persona. The starter Persona is there to change or keep. The Role is shown greyed out: it is the app's brief for the bot, it shapes how the bot works with the others, and Settings is where you change it.
5. Add more bots, or finish. Marimo Bot alone works too. Settings is where you make another.

Every step has a Back button, so you can change an earlier answer without starting over.

The model is first because the guided bot maker needs something that can answer, and the Space comes next because most of what a bot does is easier when it has a folder to work in. The app will not move past the model step until it can answer.

After setup, Settings is one screen, and the bots and Spaces are in the sidebar. The `+` beside Bots makes another bot. `Ctrl+K` opens Recall. The app stays in the tray until you quit it from there.

One bot is enough for most days.

## Questions

### Do I need an account with Marimo Bot?

No, you need an account with the model service you choose, or a llama.cpp server.

### Can I use it without making a bot?

Yes, Marimo Bot is useful on its own, and bots are for work you repeat.

### Does it work offline?

The app, your chats and Recall work without a network, but a chat needs a model, and an online model needs the internet while a llama.cpp server can stay on your own machine or network.

### Do I need a graphics card?

Not for Recall, which runs on the processor. If you run llama.cpp on the same machine, a graphics card helps speed and the model has to fit in its memory, so a bigger model may need more card than you have.

### Where are my files?

Your Space files stay in the folder you chose, and the app's own data is in its data folder, which on Linux is `~/.config/Marimo Bot`.

### What happens when I close the window?

The app stays in the tray and a scheduled job keeps going. You quit from the tray menu when you want it to stop.

### Can I change a bot later?

Yes, Settings has its Role, Persona, tools, model, Space and icon.

### Does it send my work anywhere?

Only where you ask it to: an online model receives the conversation you send it, a web search receives the query, and a connector receives what it is asked to do, while Recall downloads its engine and model once and then keeps its index and searches on your machine.

### What is not finished?

See the next section for the short answer: Windows and macOS installers, auto update, Discord, notes and to-do tools, and a skills editor.

## What is not finished

- The Windows and macOS installers are written but not built. Only the Linux AppImage has been run.
- There is no auto update. A new version is a file you download again.
- Discord and the notes and to-do lists are partly built, but nothing in the window turns them on yet.
- Skills are small saved instructions. They live in a file, and there is no editor for them in the window yet, so you edit that file by hand.
- The app checks the Recall download against a fingerprint, but there is no signature to prove where it came from. No other model is downloaded.

## Requirements

Will it run on my machine? These are the things it needs.

- A 64-bit version of Linux, Windows or macOS. Linux is the only one with a built installer today.
- About 310 MB for the recall model, 555 MB more for media, plus an index that grows with the folder.
- An account and a key with an online service, if that is what you picked. A llama.cpp server needs no key.
- If you run llama.cpp on this machine, close games and video editors before starting it. The model and the game want the same video memory.

The app carries no chat model, so you can change services without downloading a new one, while Recall is the only model the app runs itself and only after you turn it on.

Go build your next thing with it.

## For developers

The design decisions, the code layout and how to build a release are in [TECHNICAL.md](./TECHNICAL.md). The blunt working notes, including the rules that are easy to break, are in [AGENTS.md](./AGENTS.md).

## Licence

Apache-2.0. See [LICENCE](./LICENCE) and [NOTICE](./NOTICE).
