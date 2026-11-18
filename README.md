<p align="center">
  <img src="./apps/desktop/public/marimo-logo.png" alt="Marimo Bot" width="180" />
</p>

<h1 align="center">Marimo Bot</h1>

<p align="center">A desktop helper that works inside a folder you choose, with an AI model you run on the same computer.</p>

> [!WARNING]
> Marimo Bot is under construction. It changes often, and some changes are breaking. Keep your own copies of anything you care about.

I built Marimo Bot to sit on your computer and work inside a folder you choose. It reads and writes the files there, remembers what matters, and keeps a few helpers, called bots, for work you repeat.

The part that writes the answers is not built in. You run a model server on the same computer, and Marimo Bot talks to it there. There is no account, no key to paste, and no hosted service in the middle. The app does not download the model that answers you, start the server, or send your conversation anywhere else.

If you turn spoken replies on, the app downloads a small voice model and runs it here. If you turn voice input on, it downloads a second small model and runs that on your processor. Both are optional.

The conversation goes from this window to the server on this computer, and no further. The app can search the web and talk to connectors when you ask.

Marimo Bot keeps a conversation's full history and the instructions it was running under, so reopening a chat does not start it over. The chat window and the moss ball share one conversation. A question you ask from the corner of the screen is waiting in the window when you open it. The folder you were working in comes back with it.

## On this page

- [The short version](#the-short-version)
- [Words this guide uses](#words-this-guide-uses)
- [What it can do](#what-it-can-do)
- [Model server](#model-server)
- [Connectors](#connectors)
- [Privacy and control](#privacy-and-control)
- [Getting started](#getting-started)
- [Questions](#questions)
- [What is not finished](#what-is-not-finished)
- [Requirements](#requirements)
- [For developers](#for-developers)
- [Licence](#licence)

## The short version

- Work in a folder, not a chat that forgets where it is.
- Use a model server on this computer. This guide uses llama.cpp with Gemma 4 12B because that is what the build is tested with. Another local server works too.
- Attach a picture and a model that can see pictures can read it.
- Search the web when the answer is not on this machine.
- Make bots for writing, research, code or whatever you repeat.
- Let one bot ask another for help, with the helper's permissions and approvals kept in the same chat.
- Keep a memory that follows you between folders.
- Let a bot ask for a tool or a change, and decide each request yourself.
- Rename and move files around the folder, and delete one when you turn that on.
- Find a file by what it was about, not the exact words.
- Schedule a job and close the window.
- Ask the moss ball when you do not want the window.
- Hear an answer read aloud, in one of 11 English voices.
- Speak a question instead of typing it, transcribed on the processor.

### What you need first

- A computer running Linux, Windows or macOS. The Linux build is the one that has been run end to end.
- A model server on the same computer, with a model loaded. The app does not include one. [Model server](#model-server) has the setup this guide uses.
- About 6.5 GB of disk for the tested model and its image reader, and about 10 GB of memory or graphics memory to run it.
- A microphone if you want to talk instead of type. Everything else works without one.

Ready to try it? Jump to [Getting started](#getting-started).

## Words this guide uses

| Word | What it means |
| --- | --- |
| Space | A folder the app is allowed to work in. |
| Bot | A helper with its own instructions, tools, memory and chats. |
| Model | The part of the AI that writes answers. |
| Model server | The program that runs the model and answers the app. It is separate from Marimo Bot. |
| Token | A small piece of text. Models count tokens to measure how much they can read at once. |
| Context window | How much text the model can hold at once, counted in tokens. |
| Tool | An action a bot can take, such as reading a file or searching the web. |
| Connector | A server you add in Settings to give a bot more tools. |
| Skill | A saved set of steps a bot can follow. |
| API | The common way two programs talk. The app needs a local server that speaks the same API as OpenAI's chat service. llama.cpp does. The app does not contact OpenAI. |
| MCP | The Model Context Protocol, the standard connectors use to describe their tools. |
| GGUF | The model file format llama.cpp uses. |
| UTF-8 | The common plain-text format. The file editor opens these files. |
| Markdown | A plain-text format for notes with headings, lists and links. The editor shows a Preview for these files. |

## What it can do

### The folder you work in

A Space is a folder.

The app can read and write the files in that folder, and nowhere else. Load a folder and every chat you start there is filed under that Space.

On a fresh install the app creates a folder called `Marimo` inside your home folder and starts you there. It is a project of its own, not your whole home directory. Load another folder whenever your work already lives somewhere else.

The work lands in the same place as the rest of your project, so you can open the files with the editor or tools you already use.

Renaming a file is the `rename_file` tool. The file stays in the folder it is already in. It changes the name and nothing else, and it will not replace a file that already has that name. It tells you the name is taken instead.

Moving a file into another folder, or onto a name that is already there, is `move_file`. A move onto an existing file replaces it, so the app asks first.

Both are in the **Off until you turn it on** group in Settings, and both are off on a fresh install. **Power user** turns them on, and so does the "Do things for me" bot card.

Deleting a file is a Power tool as well. It is off until you turn the `delete_file` switch on in Settings. It removes one file each time, never a folder, and it does not use the bin.

The file is gone, and the app asks before every delete. Moving a file onto an existing one and deleting one cannot be undone.

### Pictures

Attach a picture with the `+` beside the message box. If you name a picture in your Space and ask about it ("what is in Ladybug.png?"), the app attaches that picture to the message. The picker is for pictures from elsewhere, or for attaching one without naming it.

A model that can see pictures reads the image itself, so you can ask what is in a screenshot, a diagram or a page you photographed. Start the server with its image reader, as [Model server](#model-server) shows.

The chat shows the picture at a size that fits the message. Click it for a larger view. Escape, the close button or a click outside closes it.

The picture is attached to that one message. Attaching it does not copy or index it, and it goes no further than the model server on this computer. Recall indexes a Space's pictures, audio and video only if you turned media search on.

### The web

Ask about something that is not on this computer and the bot can search the web. The query goes to DuckDuckGo, and the model gets back titles, addresses and a short snippet for each result.

The bot is told to cite the address it used, and to treat the results as information to read, not as instructions to follow.

Search is on by default.

Reading a whole page is a second tool, `http_fetch`, and the Standard setup leaves it off. A search always goes to the search engine. A fetch goes to whatever address the model was given, so it is a separate decision.

Turn it on in Settings and the bot can download an `http` or `https` page up to 512 KiB, about half a megabyte. Addresses on this computer or your own network are refused.

### Documents

The Documents drawer lists the files already in the folder, hidden ones included. It leaves out the app's own state, `.git`, and folders for dependencies and build output. You can edit any plain-text file (UTF-8) there, and the bot sees your changes.

A picture is listed too. Click it to open it in the viewer at the size a picture in the chat gets. The editor opens plain text only. A PDF or another non-text file is listed, and the app says it cannot open it as text instead of damaging it.

Markdown gets a Preview. Everything else is edited as plain text. If a bot writes a file, it appears in the drawer.

Drag the drawer's left edge to make it wider or narrower. The width is remembered. Drag the divider above the editor to give the open file more room. That split is remembered too.

If a file changed while you had it open, the app will not overwrite it. It keeps your draft and asks which version wins. An automatic overwrite would replace the version on disk, and the app cannot know which one you meant to keep.

You can save a chat as a document, with the messages under the author's name. A new file is written straight away. Overwriting one asks first.

### Bots

What kind of work do you repeat? A bot is for the work you do again and again.

A bot has its own name, instructions, tools, memory and chats. You can make one for writing, one for research, one for code.

Every bot has a Role and a Persona. The Role is the app's job description: what the bot is for and the rules every bot follows. The Persona is yours: its character, the job in your own words and how you want it to talk to you.

The app reads the Persona after the Role, so your words win on tone. The Persona cannot give a bot a tool it was not given. The tool list is separate, and the rules for how it works come last.

The app can restore the Role, but it will not reset the Persona on its own.

There are three ways to make one.

1. Start from a role. Pick Writer, Marketer, Researcher, Coder, Analyst or Personal assistant. You get a name, a Role, a first Persona and tools. Change the name if you like.
2. Build it step by step. Choose a role or start blank, name it, and pick what it can do.
3. Talk it through with Marimo. Marimo asks what the bot is for, drafts it and shows you a card. Change the name, the starter role or the Persona, then press Create. Nothing is made until you do. The card then says which bot it made: one card makes one bot, so pressing Create again does not leave two.

Pick a starter role when one fits. Build it step by step when you want to choose every part. Talk it through with Marimo when you would rather answer questions than fill in a form.

Bots sit at the top of the sidebar, and picking one shows its chats. Settings has its Role, Persona, tools and Space. The icon can be one of five shipped pictures, or one you upload.

A line separates the bots from the Spaces below them. The `+` beside Spaces starts a new chat in the Space you have open, and the folder button on a space opens it in your file manager.

Drag the sidebar's right edge to widen it. The width is remembered.

Settings → **Appearance** has the theme. **System** uses this computer's light or dark setting, and **Light** or **Dark** pins one.

Several bots can share a chat, so type `@` to put a question to one of them. Marimo Bot can also hand work to a bot. The helper runs with that bot's tools in the same chat. If it needs permission, the card appears there, and the helper continues after you approve.

Removing a bot asks first. It takes the bot's chats, jobs and memory with it. Files it wrote in your Spaces stay, and the last bot stays too, because something has to answer.

### The bot's history

Every conversation keeps a record of what was said and the instructions the bot was using. Settings → **Harness**, the bot's history card, shows that record for the current bot: conversations, turns, tokens, suggestions, skills and scheduled jobs. It also lists the versions of its instructions and tools.

Restoring an earlier version puts back the bot's name, Role, Persona, tools, skills, connectors and how it runs: how memory is recalled, how much room a turn has before it is summarised, and how many tools a turn may use.

It leaves the model server setting, the Space, the icon and memory alone. The server is an app-wide choice, and undoing a choice the person did not make in that dialog would be a surprise.

### Skills

A skill is a procedure a bot can pick up and follow: how you like an inbox sorted, how a report should be laid out, how to edit AI-sounding prose.

A skill lives in its own folder as `SKILL.md`, a short note saying what it is for and the steps underneath.

The bot sees the name and that one-line note in every conversation. It reads the steps only when a task matches them, so a long procedure does not make every answer slower.

Settings has a **Skills** card. Write one there, or copy a folder into the skills folder in the app's data folder. The switch beside each skill decides which bots may use it.

A bot can also write one. Turn on `save_skill` under what the bot can do, then ask it to remember a way of working. Or run **Learn a skill** from the `+` menu after a conversation.

It writes the skill, shows you what it is about to save, and switches it on for that bot when you approve.

Settings keeps earlier versions of each skill and lets you restore one. A skill you overwrite is still your own text, so the earlier copies are there when the new wording turns out worse.

### Long conversations

When a chat gets long, the app keeps every message but gives the model a summary of the earlier part so it can keep going. **Compact** in the `+` menu does the same when you ask.

A small model can hold less text at once than a large one. The app keeps the text it sends under about 24,000 tokens and treats the rest of the conversation as something to summarise or search, instead of sending a request the server cannot fit.

### Memory

A fact about you follows you between Spaces, while a note about how a project is set up stays with that project. The app keeps the two apart.

What does it remember? Settings lists every line and when it was written, with a search box and a **Forget** button.

When you tell it something about yourself, such as your name, where you live, or the people and animals in your life, it writes that down as you say it, before it answers, and uses it when you ask. Say a different name later and the old line is replaced, so memory never holds both.

If an answer is wrong, choose **Not quite**. The correction is recorded, and the next review turns it into a remembered fact.

A review also reads a conversation after it goes quiet and writes down what it noticed without being told. Each fact it writes has to be supported by a sentence from the conversation, so it cannot invent one and file it away.

You do not approve memories. They appear in Settings, where you can forget any line you do not want.

Memory has a soft limit, so the bot is told when it gets close and can remove what no longer matters. The memory file is plain text, so you can read it without the app.

### Learning

The bot can ask to change what it is able to do. It can ask for a tool or a connector it kept needing, or suggest a change to how it runs. None of that happens on its own.

Each request waits in **Learning** in Settings, with the reason it gave and the part of the conversation it came from. Remembering a fact is not one of these requests. That is written straight into Memory, as above.

A tool or connector request names the capability and says why the bot needed it. A change to how it runs covers how memory is recalled, how much room a turn has before it is summarised, and how many tools a turn may use.

The bot cannot change its Role, its Persona or the app's rules, and it cannot give itself the ability to run commands.

If you say no, it remembers the answer for about six months and stops asking. The Learning card lists those refusals and lets you clear them.

The bot also looks for housekeeping it can suggest. When memory is over the limit you set, it may suggest forgetting the oldest fact. When a skill has not been used in a while, it may suggest retiring it. Both are suggestions, and both wait for you.

### Recall: find by meaning

Use Recall when you remember what a file was about but not the words in it. Press `Ctrl+K`.

It uses a small model called EmbeddingGemma 2. The model turns a piece of text into a list of numbers, and the app compares those numbers so a search for an idea can find a file whose exact words you have forgotten. It runs on your processor.

Recall is off until you turn it on.

The first time you turn it on, the app downloads the search program and the model. The main model is 310 MB. The part that handles pictures, audio and video is another 555 MB, and you only need it for media search.

What does it search? You choose files, memory, past chats and media. When a Space is loaded, the index stays inside it. The index is a searchable map of those numbers.

The index keeps itself current. It catches up in the background after each answer and when you search, in small slices, so a conversation you have just had can be found without indexing it by hand. **Index now** forces a pass when you want one.

A result shows how close the match is and whether the file has changed since it was indexed. After the download, Recall runs on your computer, so your searches stay local.

### Jobs

What happens while the window is closed? A scheduled job keeps going.

Schedule a task, such as a summary every morning. Closing the window does not quit the app. It stays in the tray, the small icon near your clock.

The **Jobs** card in Settings has a switch called **Keep jobs running when the app is closed**. It installs a small background worker so a timer can wake it and run due jobs.

The same card lists every job any bot has scheduled: the bot that owns it, the words it will run, when it next runs, and how the last run went. Pause, resume or delete one there, or open the conversation it reports into. You make a job in a chat by asking a bot to schedule it.

The worker is a small copy of the app that runs due jobs while the window is closed. It takes turns with the app so the two never write to one chat at the same time.

A job needs your model server running. The worker connects to it for the turn. It never starts or stops that program. If nothing is answering, the job records that as its result instead of running without a model.

Then it goes back to sleep until the next job is due. To quit, use the tray menu.

A job runs in its own conversation, with the same tools and approvals as a chat. One thing is missing when the background worker runs a job: it has no browser. A job that needs a web search has to run while the app is open.

### The companion

The moss ball is another way into the same conversation. It floats above your other windows with its own chat bar.

Settings lets you choose how long its answers are, how many messages float above it, and whether it stays on top. It also decides whether clicks pass through it to the window behind.

### Spoken replies

Settings → **Spoken replies** turns the voice on. The voice model is about 92 MB, downloaded once when you press **Download voice model**, and it runs on this computer. After that, a finished answer is read aloud in the window that asked, either the main window or the moss. Nothing about it leaves the machine. The first sentence starts playing while the rest of the answer is being made, so a long reply does not wait for its last word.

The card lists the model's 11 English voices with the one-line description that comes with each. **Play sample** speaks a sentence in the selected voice. The first sample waits while the model loads, and later ones do not. **Speed** changes how fast the voice speaks, from 0.5× to 2.0×, and the sample uses the same speed.

A spoken answer is **Brief** by default. A listener cannot skim, so the model is asked to lead with the answer and leave out the caveats. **How long spoken answers are** changes that for either window. The companion's own answer length still applies when spoken replies are off.

Technical answers keep their words. A filename, a code identifier, an acronym or a name the voice's word list does not know is split into speakable parts or given a close guess at how it sounds, instead of being dropped. Under **This bot**, one bot can have its own voice and speed, so a Coder can sound different from the moss. Every stored answer has a **Speak** button, so **Read answers aloud** can stay off while you listen to one reply on demand.

**Stop** beside the composer, or beside the moss's bar, ends a playback without stopping the turn. With spoken replies off, **Remove voice model…** deletes the cached files and frees the disk space. The voice model in this build speaks English. The other fifteen languages it carries need their own text readers, and this build does not include them.

### Voice input

Settings → **Voice input** turns the microphone on. The model is Moonshine Streaming Small, about 158 MB (165,489,086 bytes), downloaded once when you press **Download voice input model**. It is English only, and it runs on this computer's processor, so it takes no graphics memory from the model server. The audio is recorded in the window, transcribed here, and discarded. Nothing about it is sent anywhere.

A microphone button sits beside the composer and in the moss bar. Press it to start, press the square to stop and transcribe, or the **×** to throw the recording away. The live level shows that the selected microphone is hearing something. While a recording or a transcription is open, the other window's microphone is disabled: one microphone at a time.

The card lists the input devices, follows a headset being plugged in or removed, and remembers the one you chose. If it disappears, the system default is used and the card says which microphone is missing. **Test microphone** shows the level even before the model is downloaded. With the model installed, the test clip is transcribed on the card so you can check the whole path.

**Send the transcript immediately** is off by default. The words go into the message box so you can read and edit them. Turn it on to send the turn as soon as the transcription finishes. **Stop after silence** is also off. When it is on, it ends the recording after about 1.5 seconds of quiet once you have started speaking. A noisy room may never count as quiet, and the square is always there.

A clip stops at 60 seconds so a microphone left open cannot use too much memory, and the model unloads after five quiet minutes. Starting a recording stops a spoken reply in either window, so the microphone does not transcribe the bot's own voice. With voice input off, **Remove voice input model…** deletes the cached files. It refuses while a recording or transcription is running.

## Model server

No model comes inside the app, and the app does not download the model that answers you.

The app talks to a model server on this computer. The server has to speak the same API as OpenAI's chat service, which is the common way these programs talk. [llama.cpp](https://github.com/ggml-org/llama.cpp) is the one this guide uses, because it is what the app was built and tested against. Another local server that speaks the same API works too.

The app never starts, stops, sleeps or upgrades the server. That process, its memory, its graphics card settings and its own idle behaviour are yours. Settings → **Model server** only says whether it answers, what it calls its model, and how much text it can hold.

### The tested setup

The setup this build is developed and tested against is **Gemma 4 12B IT** at **UD-Q4_K_XL** (about 6.3 GB), with its image reader, served by llama.cpp:

```bash
llama-server \
  -m gemma-4-12B-it-qat-UD-Q4_K_XL.gguf \
  --mmproj mmproj-F16.gguf \
  -c 16384 -fa on -ngl 99 \
  --parallel 1 -ub 1120 \
  -ctk q8_0 -ctv q8_0 \
  --jinja --host 127.0.0.1 --port 8080
```

The model is a compressed version of Gemma 4 12B. `UD-Q4_K_XL` is the compression setting, and the `.gguf` file is the model file. The image reader is a separate file that lets the model see pictures. The command uses `mmproj-F16.gguf`; if the repository offers `mmproj-F32.gguf`, that works too. Get both from the model's repository. In LM Studio, search for `unsloth/gemma-4-12B-it-qat-GGUF`. Run the command from the folder that holds the files.

The flags are memory and speed settings. You can copy the command as it is if your file names match. The notes below explain what each one does, and what to change if something refuses.

- `-m` names the model file.
- `--mmproj` names the image reader. Without it the model still answers text, but it cannot read a picture.
- `-c 16384` is how much text the model can hold at once. The app keeps a quarter back, so a turn gets about 12,000 tokens.
- `-fa on` and `-ctk q8_0 -ctv q8_0` are memory-saving options for the model's scratch space. Use both or neither.
- `-ub 1120` gives a picture more room than llama.cpp's default 512.
- `--parallel 1` means one answer at a time, which is how the app runs.
- `--jinja` tells llama.cpp to use the model's own instructions, which is where tool use is defined.
- `--host 127.0.0.1` keeps the server on this computer. Use `0.0.0.0` only if another device needs it.

It needs about 10 GB of graphics memory, or the same amount of system memory when it runs on the processor, and about 6.5 GB of disk for the model and image reader. On a smaller card, lower `-c` to 8192 for about 6,000 tokens a turn, or use a smaller model. With no usable card, change `-ngl 99` to `-ngl 0`. If your llama.cpp build refuses the compressed cache, drop `-ctk q8_0 -ctv q8_0`. It will need more memory.

Any local server that uses the same API works, and any model works if it knows how to ask for tools. The setup above is the one this build is tested against.

### Connecting the app

Start the server, then put `http://127.0.0.1:8080/v1` in the first run or in Settings → **Model server**. The address is tidied up: `localhost:8080` becomes `http://localhost:8080/v1`, and a trailing slash is ignored.

Only this computer is allowed. The app accepts `localhost`, `127.0.0.1` and `::1`. A public address, a public IP or a server on your network is refused with a sentence, so the conversation cannot leave this computer.

The model is whatever the server loaded. **Test connection** asks the server what it reports and fills the model list. Leave the model field blank to use the first one. If the server has several models loaded, you can point the app at one by name.

How much text it can hold comes from the server. The app asks for that number and uses it when it answers. If the server does not report one, the **Context window** field is the fallback. The app keeps a quarter back for the reply and the descriptions of the tools it may use, so the tested 16,000-token server gives a turn about 12,000 tokens.

The model has to know how to use tools. The tested model knows how to ask for tools, and `--jinja` is what makes llama.cpp use the model's own instructions. If a server reports that its model does not know how to ask for tools, the turn still runs, but the bot can only talk. It cannot read your files, run jobs or use connectors, and it may describe work it did not do. The first run warns you before you continue and the button reads **Continue without tools**. The Model server card and the composer's **no tools** badge keep saying it afterwards. The fix is a model that knows how to ask for tools.

The badge shows the state. The composer's badge says whether the server is connected, not answering, or failed. It also says **no tools** when the server answers but its model does not know how to ask for tools. Click it to open the Model server card. A server that is off when the window opens does not send you back to setup. The chat opens with a notice naming the address, and **Try again** checks it immediately. The app checks again on its own every twenty seconds.

Pictures need the image reader. A model that can see pictures still answers text without its image reader, but it cannot read an attachment. The tested command points `--mmproj` at the image reader. A different model that can see pictures needs its own file.

### Old model files

An install from before this change may still have old model files: **Qwen2.5 VL 7B**, the app's own llama.cpp engine, or the **LFM3 1.7B**, **LFM3 VL 2B**, **LFM3 Audio 2B** and **LFM3 Omni 2B** files. They are not used any more. Settings → **Model server** lists whichever are still there, and **Remove…** deletes one after you confirm. Recall's files are under `model/recall/`, the voice model under `model/tts/` and the voice-input model under `model/listen/`. None of those is in that list.

## Connectors

A connector is a server you add in Settings. It can give a bot tools that live in another app or on another machine: a database, an issue tracker or a service on your network. MCP is the common language those servers use to describe what they can do.

Each bot has its own permissions, and a connector that is not ticked is not offered to that bot. A connector is untrusted until you say otherwise. Every tool it offers asks before it runs, and trusting the connector is what stops the asking.

A bot can ask for one it does not have. The request waits in Learning with the reason it gave, and nothing changes until you approve it.

A connector's password or access key is stored like any other secret. The background worker can only use one stored so the worker can read it, and only if you tick that box.

## Privacy and control

Your conversations, files and memory stay on this computer. The model server is on this computer too. The app refuses a server address that is not on this computer, and an attached picture goes no further than that server.

The chat is a request to the server at the address in Settings. The app cannot send it to a public address: `localhost`, `127.0.0.1` and `::1` are the only hosts it accepts.

The app reaches the network only for things you ask for:

- A web search sends the query to DuckDuckGo.
- A page fetch goes to the address the bot was given, once you have turned that tool on.
- A connector talks to the server you set up.
- Recall downloads its search program from GitHub and its model from Hugging Face, once.
- Spoken replies download the voice model from Hugging Face once, only when you press the button. The speech is made on this computer.
- Voice input downloads its model from Hugging Face once, only when you press the button. The audio is transcribed on this computer and never sent anywhere.
- **Check for updates** asks GitHub for the latest release only when you press it.

The app keeps its own data in one folder. On Linux that is `~/.config/Marimo Bot`. Your chats, the Spaces you loaded, the old chat files and your settings are there. Recall's model is under `model/recall/`, the voice model under `model/tts/` and the voice-input model under `model/listen/`. If you set `MARIMO_MODEL_DIR`, those models live wherever that points instead.

A connector's secret is in your computer's secure password store, except one you let a background job read. That one is stored in the app's data folder so the worker can read it.

The app's own data lives somewhere else. A Space's files stay where you put them.

A command, a save over a file that already exists, a move onto a name that already exists, or any delete waits for your answer. The app writes a new file without asking. A scheduled job that hits an approval stays paused, and the request survives a restart.

Every built-in tool is a switch in Settings. If a tool is off, the app does not offer it to the model at all. A connector's tools follow the connector's own switch.

Above those switches, Settings offers the same two grants the first run writes: **Standard** and **Power user**. The first run calls them Regular and Power setup. Either way they set the whole list at once, and every switch stays there to tune afterwards.

Recall is off until you turn it on. After that, it runs on this computer and sends nothing about your files anywhere.

Reset Marimo Bot, at the bottom of Settings, erases the app's folder, switches off start-at-login and the timer that runs jobs, and quits. It does not delete a Space. It deletes any old chat model files in that folder, Recall's model and search program, the voice model and the voice-input model, unless `MARIMO_MODEL_DIR` points them somewhere else. Your model server's files are yours and are not touched. There is no undo.

## Getting started

There is no public download yet. The Linux version builds to a single AppImage file you can run without installing it. The Windows and macOS installers are written but not built.

If you have the app, the first run asks a few questions and then shows only the steps those answers call for.

1. Choose a setup style. **Regular** gives Marimo Bot the everyday tools. **Power setup** gives it every tool, including writing files, running commands, scheduling jobs and handing work to other bots. Anything that changes something still asks first. You can change this later.
2. Say what you want to do. Pick any goals that fit: files, the web, writing, code, bots, pictures or jobs. They choose which steps appear and which starter bot is suggested. They do not give Marimo Bot any tools. Scheduling is part of Power setup. A writing or coding goal suggests a bot with its own tools.
3. Connect your model server. Start it first. The command in [Model server](#model-server) is the tested setup. The step offers `http://127.0.0.1:8080/v1` and a **Test connection** button. **Continue** stays disabled until the address answers. If the model does not know how to ask for tools, it warns you and the button says **Continue without tools**. **Set this up later** closes the flow, and Settings → **Model server** connects it afterwards. Pictures need the server's image reader.
4. Choose a Space. Marimo starts you in `Marimo`, a folder it creates in your home folder. Pick another folder if your work already lives there. The app can read and write there, and nowhere else. You can skip this.
5. Make a bot, if a goal calls for one. Start from the suggested role, build it step by step, or talk it through with Marimo. Some goals, such as files or pictures on their own, skip this step. The `+` beside Bots makes one later.
6. Make it yours. Pick an icon and write its Persona. The starter Persona is there to change or keep. The Role is shown greyed out. It is the app's brief for the bot, it shapes how the bot works with the others, and Settings is where you change it.
7. Add more bots, or move on.
8. Jobs, if Power and scheduling were chosen. Turn on **Keep jobs running when the app is closed**. A job that hits an approval stays paused. This is optional, and the same switch is in the Jobs card.
9. Review and start. The last step says what was configured: the server, its model, the Space, the bots, and any pictures or jobs. Then it opens a new chat in the Space you picked, so the first thing you type lands in the folder you meant. If you kept the starting folder, it leaves you in the chat that folder already had.

Every step has a Back button, so you can change an earlier answer without starting over.

The setup style comes first because it is about access. The goals come next because they are what make the flow shorter for someone who only wants to chat and longer for someone who wants pictures, bots or scheduled work.

The server connection is the one required step because the app cannot answer without it. The rest is optional and can be changed afterwards, including the address.

After setup, Settings is one screen, and the bots and Spaces are in the sidebar. The `+` beside Bots makes another bot, and the one beside Spaces starts a chat. `Ctrl+K` opens Recall. The app stays in the tray until you quit it from there.

One bot is enough for most days.

## Questions

### Do I need an account?

No. The model runs in a server you start on your own computer. There is no account and no key to paste.

### How big is the download?

The app downloads no chat model. It downloads Recall's search model (310 MB, or 865 MB with media search) only if you turn Recall on, the voice model (about 92 MB) only if you turn spoken replies on, and the voice-input model (about 158 MB) only if you turn voice input on. The chat model is whatever you loaded in your server.

Settings → **Model server** lists any old chat files from an earlier version so you can remove them.

### Can I use it without making a bot?

Yes. Marimo Bot is useful on its own, and bots are for work you repeat. The setup only offers the bot step when a goal asks for one. The `+` beside Bots makes one later.

### Does it work offline?

Yes, when the server and the model are on this computer. No network is needed for a conversation, your files, memory, spoken replies after the voice model is downloaded, or voice input after its model is downloaded. A web search, a page fetch, a connector and the update check need one.

### Do I need a graphics card?

The app leaves that to the server. It sends the request and the server decides. llama.cpp runs on the processor when it has no usable card, and uses one when it does. That is the server's setting, not this app's. The tested command uses `-ngl 99` to put every layer on the card. With no usable card, change it to `-ngl 0` and expect it to be slower. Recall and voice input always run on the processor.

### How much memory does it need?

Whatever the model you loaded needs, plus what the server needs to run. The setup this build is tested against (Gemma 4 12B compressed to 4 bits, a 16,000-token window and the image reader) is about 10 GB. A 7B model compressed to 4 bits with a 32,000-token window is about 8 GB. A larger model or a larger window needs more. The app asks the server how much text it can hold and keeps a quarter back for the reply and the descriptions of the tools it may use. Voice input uses about 450 MB for a short clip, or about 1 GB at its 60-second cap, then unloads after five minutes.

### Where are my files?

Your Space files stay in the folder you chose. The app's own data is in its data folder, which on Linux is `~/.config/Marimo Bot`. Old chat files, Recall's model, the voice model and the voice-input model are under `model/` inside that folder unless `MARIMO_MODEL_DIR` points somewhere else. The model your server loaded is wherever you keep it. The app never copies it.

### What happens when I close the window?

The app stays in the tray and a scheduled job keeps going, if **Keep jobs running when the app is closed** is on and your model server is running. You quit from the tray menu when you want it to stop.

### Can I change a bot later?

Yes. Settings has its Role, Persona, tools, Space and icon. The bot's history card, **Harness**, can also restore an earlier version of the bot's name, Role, Persona, tools, skills and connectors, along with how it runs.

### Does it send my work anywhere?

Only where you ask it to. A web search sends the query, a page fetch goes to the address it was given, and a connector receives what it is asked to do. The conversation itself goes to the model server at the address in Settings, and that address has to be this computer. A spoken reply is made on this computer. Voice input records only while the microphone button is on, transcribes the audio on this computer, and sends only the finished text, and only if you send it.

Recall's download contacts Hugging Face for its model and GitHub for its search program. The voice model and the voice-input model each contact Hugging Face once, when you press their buttons. The update check contacts GitHub only when you press the button.

### What is still missing?

The next section lists what is missing.

## What is not finished

- The Windows and macOS installers are written but not built. The model server runs independently, so the installer has no chat model to download or start. Only the Linux AppImage has been run end to end.
- There is no automatic updater. Settings can check for a newer release and open its notes, but downloading and installing is still a manual step, and releases are not signed yet.
- There is no field for a server password. Some servers can require a password. A local server started with `--api-key` is refused with a sentence instead of being sent an empty key.
- A server on another machine is refused. This build accepts only addresses on this computer, so a llama.cpp on your network is not reachable from here yet.
- Tool use depends on the model knowing how to ask for tools. A model that does not know how to ask for tools answers in prose and cannot use files or jobs. The first run, the Model server card and the composer badge all say so.
- The background worker has no browser, so a scheduled job that needs a web search runs only while the app is open.
- A job repeats on a schedule, in your local time. There is no one-off reminder that fires once and stops. "In two minutes" has to be expressed as a repeating schedule, and the Jobs card shows the schedule that was actually stored.
- Discord and the notes and to-do lists are partly built, but nothing in the window turns them on yet.
- Recall's downloads, the voice model and the voice-input model are checked against a fingerprint, but there is no signature to prove where they came from.
- Spoken replies are English only in this build. The voice model itself carries 16 languages and 118 voices. The other 15 languages need their own text reader, and none of them is wired up yet.
- Voice input is English only and transcribes after you stop, not word by word while you speak. A clip is capped at 60 seconds.

## Requirements

Will it run on my machine?

- A 64-bit Linux, Windows or macOS computer. The Linux build is the one that has been run end to end.
- Room for whatever model you run. The tested model and its image reader take about 6.5 GB. The app adds nothing to that.
- About 310 MB of disk for Recall, or 865 MB with media search, about 92 MB if you turn spoken replies on, and about 158 MB if you turn voice input on. A working microphone is the only extra hardware voice input needs, and it asks nothing of the graphics card. An upgrade from an old version needs room for its leftover chat files until you remove them from Settings → **Model server**.
- Enough memory for your model and the amount of text it holds. The tested Gemma 4 12B, compressed to 4 bits, with a 16,000-token window is about 10 GB of graphics or system memory. A 7B model compressed to 4 bits with a 32,000-token window is about 8 GB.
- No account and no key. A graphics card is not required. Your server decides whether to use one.

The app carries no hosted service. It answers from a server on this computer, and Recall, spoken replies and voice input download their own small models.

Go build your next thing with it.

## For developers

The design decisions, the code layout and how to build a release are in [TECHNICAL.md](./TECHNICAL.md). The conversation format is described in [docs/harness-v2.md](./docs/harness-v2.md). The blunt working notes, including the rules that are easy to break, are in [AGENTS.md](./AGENTS.md).

## Licence

Apache-2.0. See [LICENCE](./LICENCE) and [NOTICE](./NOTICE).
