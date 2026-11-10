/**
 * Every tool Legacy has, loaded in one place (v1.57).
 *
 * WHY THIS FILE EXISTS. Legacy has two ways in — src/index.js for the terminal
 * and src/server.js for the voice and browser — and each one used to carry its
 * own list of tool imports. They drifted, silently, because nothing ever
 * compared them:
 *
 *   · website-shop.js was imported by the terminal only, so through the
 *     browser and voice — the way Shahyd actually uses Legacy — the
 *     website_* tools never registered at all. Marli fell back to the local
 *     shop, found it empty, and said so. Everything else was configured
 *     correctly, which made it look like a connection problem when it was
 *     a wiring problem.
 *   · track.js, documents.js, whatsapp.js, facebook.js, media.js and
 *     modelswitch.js had drifted the other way and were missing from the
 *     terminal.
 *
 * A missing import does not throw. The tool simply is not there, the agent
 * quietly loses that capability, and the failure surfaces somewhere else
 * entirely as "it says it is empty". That is the worst kind of bug.
 *
 * So: both entry points import THIS FILE and nothing else. Drift is no longer
 * possible, because there is only one list.
 */

import './bookings.js';
import './clients.js';
import './browser.js';
import './edit.js';
import './journalcard.js';
import './audio.js';
import './bills.js';
import './stock.js';
import './secondscreen.js';
import './sources.js';
import './transcribe.js';
import './calllog.js';
import './manage.js';
import './selfcode.js';
import './finder.js';
import './nearby.js';
import './gmaps.js';
import './places.js';
import './topic.js';
import './watch.js';
import './appointments.js';
import './render3d.js';
import './desk.js';
import './hosting.js';
import './vision.js';
import './documents.js';
import './drafts.js';
import './email.js';
import './facebook.js';
import './factory.js';
import './files.js';
import './finance.js';
import './forge.js';
import './gmail.js';
import './imagegen.js';
import './ingest.js';
import './instagram.js';
import './media.js';
import './memory.js';
import './modelswitch.js';
import './notices.js';
import './obsidian.js';
import './paypal.js';
import './pc.js';
import './printing.js';
import './proposals.js';
import './repolearn.js';
import './research.js';
import './secondbrain.js';
import './skills.js';
import './socials.js';
import './studio.js';
import './subagents.js';
import './superprompt.js';
import './tasks.js';
import './telegram.js';
import './track.js';
import './ui.js';
import './website-shop.js';
import './website.js';
import './whatsapp.js';
import './youtube.js';

/* ---------------------------------------------------------------------------
 * Modules OUTSIDE src/tools/ that also register tools. They were imported by
 * server.js and not by index.js, which is the SAME drift that caused the shop
 * bug in v1.57 — this file was created to stop it and did not cover them.
 * The terminal was silently missing the morning brief, the bank log, the
 * posting calendar, the shop, the second-brain map and the token report.
 * ------------------------------------------------------------------------- */
import '../bank.js';
import '../brief.js';
import '../graph.js';
import '../lean.js';
import '../phonelink.js';
import '../reflect.js';
import '../scheduler.js';
import '../shop.js';
import '../shopwatch.js';
import '../thinking.js';
import '../triggers.js';
import '../voiceid.js';
import '../remote.js';
import '../prayer.js';
import '../dossier.js';
import '../vaultwatch.js';
import './sessions.js';
import '../audit-finance.js';
import '../whatsapp-inbox.js';
import '../health.js';
import '../settings.js';
import '../panels.js';
import '../faces.js';
import '../markets.js';
import '../deck.js';
import '../reminders.js';
import '../guard.js';
import '../scene.js';
import '../sentry.js';
import '../tiktok.js';
import '../linkedin.js';
import '../quotewatch.js';
import '../tiktokapi.js';
import '../vision.js';
import '../ideas.js';
import '../crosspost.js';
import '../closer.js';
import '../selfreview.js';
import '../socialinbox.js';
import '../emailstudio.js';
// Her own skills load after every built-in tool, so a skill can never claim a
// built-in tool's name (v3.22).
import('../skills.js').then((m) => m.loadAllSkills()).catch((e) => console.warn('[skills]', e.message));
