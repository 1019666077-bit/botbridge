# Bot Bridge Rules v1.0.1 downloads

These URLs are served by the existing Workers static assets (`assets.directory = "."`):

- https://botbridge.dev/downloads/rules/BotBridgeRules-Setup-1.0.1.exe
- https://botbridge.dev/downloads/rules/BotBridgeRules-1.0.1-win-x64.zip

The binaries are not in this repo yet. After the private `botbridge-rules` v1.0.1 CI finishes, copy those two artifacts into this directory with the same filenames and deploy. `.assetsignore` excludes `*.md`, so this note is not published.

Workers static assets allow at most 25 MiB per file. If either artifact is larger, do not commit it here. Host it on R2 under a `botbridge.dev` URL and point the Rules landing links at that URL instead.
