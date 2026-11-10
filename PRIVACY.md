# Privacy

Legacy AI runs its interface and local tools on your PC. Claude conversations
use Anthropic's API and voice transcription uses Deepgram when configured.
Requests may include the text, audio, image or document content needed for
the feature you invoke.

## Local storage

Desktop credentials are stored in `%LOCALAPPDATA%\Legacy AI\.env`.
Application settings live in `config.json`. Records, tool activity, local
memories, notification history and OAuth tokens are stored in the application's
`data` folder. Keep those folders private when sharing source or diagnostics.

Installed configuration and records are retained after uninstall so that
reinstallation can reuse them. You can remove those local files separately.

## Connected services

Tools contact the services you configure, including Telegram, LinkedIn, Meta,
Google, PayPal and the other optional providers. Each service handles requests
under its own policies. Browser tools open the sites you ask to use.
The interface also loads fonts from Google Fonts.

Kokoro speech generation and browser face and object recognition run locally.
Optional cloud voice providers receive the text to synthesize. Camera images
used for Claude vision are sent to Anthropic when that feature is invoked.

Legacy Link forwards notifications from the Android apps you select.
The desktop receiver stores a rolling local history. Notification text can
include financial or message content, and can become context for a requested
assistant action or an alert through a configured service.

## Sharing this project

The distributed source and installer contain blank credential fields.
Review your own configuration and records before sharing a modified copy.
