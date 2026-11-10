"""Run from a disposable install directory or the staged payload."""

from base64 import b64encode
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(url, payload=None, headers=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(url, data=data, headers=headers or {})
    try:
        with urlopen(req, timeout=10) as result:
            return result.status, result.read()
    except HTTPError as error:
        return error.code, error.read()


app = Path(sys.argv[1]).resolve()
node = app / "runtime" / "node.exe"
fake_key = "test-key-installed-build-only"
config = app / "config.json"
original = config.read_bytes()
logo = (app / "public" / "legacy_studios_logo.png").read_bytes()

with TemporaryDirectory(prefix="legacy-smoke-") as profile:
    env = dict(os.environ, LOCALAPPDATA=profile, APPDATA=profile)
    for key in re.findall(r"^([A-Z0-9_]+)=", (app / ".env.example").read_text(), re.M):
        env.pop(key, None)

    # Keep browser windows and external API calls out of this test.
    guard = (
        "import cp from 'node:child_process';import{syncBuiltinESMExports as sync}from'node:module';"
        "const exec=cp.execFile;cp.execFile=(file,...args)=>file==='rundll32.exe'?undefined:exec(file,...args);sync();"
        "globalThis.fetch=async()=>{throw Error('External calls are disabled during smoke tests')};"
    )

    def launch(*args):
        return subprocess.Popen(
            [node, "--import", "data:text/javascript," + guard, "src/desktop.js", *args],
            cwd=app, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", creationflags=subprocess.CREATE_NO_WINDOW,
        )

    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        settings = json.loads(original)
        settings["voice"]["serverPort"] = port
        settings["selfCheck"]["enabled"] = False
        config.write_text(json.dumps(settings, ensure_ascii=False), encoding="utf-8")
        with launch() as process:
            try:
                line = process.stdout.readline()
                url = re.search(r"http://127\.0\.0\.1:\d+/[a-f0-9]+", line).group()
                origin = url.rsplit("/", 1)[0]
                status, html = request(url)
                assert status == 200 and b"ANTHROPIC_API_KEY" in html and b"PAYPAL_SECRET" in html
                assert b"data:image/png;base64," + b64encode(logo) in html
                form = {"raw": 'DEEPGRAM_API_KEY="test#voice"\nNODE_OPTIONS=invalid', "changes": {"ANTHROPIC_API_KEY": fake_key}, "remove": []}
                headers = {"Content-Type": "application/json", "Origin": origin}
                assert request(url, form, headers | {"Origin": "https://example.com"})[0] == 403
                assert request(url, form, headers)[0] == 200
                private = (Path(profile) / "Legacy AI" / ".env").read_text()
                assert fake_key in private and "test#voice" in private and "NODE_OPTIONS" not in private
                base = f"http://127.0.0.1:{port}"
                for line in process.stdout:
                    if f"Open {base}/" in line:
                        break
                status, html = request(base + "/")
                assert status == 200 and b"Legacy" in html
                assert b'<img src="/legacy_studios_logo.png"' in html
                assert request(base + "/legacy_studios_logo.png") == (200, logo)
                assert request(base + "/", headers={"Host": "unexpected.example"})[0] == 403
                assert request(base + "/phone-link", headers={"Sec-Fetch-Site": "cross-site"})[0] == 403
                assert request(base + "/vendor/qrcode.min.js")[0] == 200
                assert request(base + "/models/objects/model.json")[0] == 200
                assert request(base + "/phone-ping")[0] == 200
                secret = json.loads(request(base + "/phone-link")[1])["secret"]
                notice = {"app": "com.example.bank", "appLabel": "Demo Bank", "title": "Funds received", "text": "You received USD 19.25"}
                assert request(base + "/phone-notify", notice, {"X-Legacy-Secret": "invalid"})[0] == 401
                assert request(base + "/phone-notify", notice, {"X-Legacy-Secret": secret})[0] == 200
                assert json.loads(request(base + "/phone-link")[1])["lastEvent"]["app"] == "Demo Bank"
            finally:
                process.kill()

        with launch("configure") as process:
            try:
                line = process.stdout.readline()
                url = re.search(r"http://127\.0\.0\.1:\d+/[a-f0-9]+", line).group()
                html = request(url)[1]
                assert fake_key.encode() not in html and b"Saved locally" in html
                status, _ = request(url, {"changes": {}, "remove": ["DEEPGRAM_API_KEY"]},
                                    {"Content-Type": "application/json", "Origin": url.rsplit("/", 1)[0]})
                assert status == 200
                private = (Path(profile) / "Legacy AI" / ".env").read_text()
                assert "DEEPGRAM_API_KEY" not in private and fake_key in private
            finally:
                process.kill()
    finally:
        config.write_bytes(original)

offline = (
    'import {env} from "@huggingface/transformers";env.allowRemoteModels=false;'
    'const {speak}=await import("./src/mouth.js");'
    'const wav=await speak("Legacy AI is ready.");'
    'if(wav.subarray(0,4).toString()!=="RIFF"||wav.length<1000)process.exit(1);'
)
subprocess.run([node, "--input-type=module", "-e", offline], cwd=app, env=env, check=True, timeout=60)
print("Passed: first-run setup, private .env import and removal, local HTTP guards, camera assets, phone notifications, offline Kokoro WAV")
