#!/usr/bin/env python3
"""
Create the read-only service account the refresh workflow runs as.

Run once. It creates `remi-dashboard-reader`, grants it exactly
`roles/datastore.viewer` on the analytics project, mints a key, and prints
that key to stdout for you to paste into the repo secret.

Why not just put your own token in the secret: the credential the firebase CLI
holds is a Google *refresh token for your whole account* — it can read and
write every project you own, and it does not expire until revoked. This one can
read Firestore in one project and do nothing else, and can be revoked on its own
without touching your login.

    python3 tools/setup_service_account.py | gh secret set REMI_SA_KEY

Authenticates as you, via the existing `firebase login`.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROJECT = "remidsp-98208"
ACCOUNT = "remi-dashboard-reader"
ROLE = "roles/datastore.viewer"

CLI_CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com"
CLI_CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi"
CONFIGSTORE = os.path.expanduser("~/.config/configstore/firebase-tools.json")

EMAIL = "%s@%s.iam.gserviceaccount.com" % (ACCOUNT, PROJECT)


def die(msg):
    raise SystemExit("setup: " + msg)


def call(url, data=None, method=None, token=None, form=False):
    headers = {}
    body = None
    if token:
        headers["authorization"] = "Bearer " + token
    if form:
        body = urllib.parse.urlencode(data).encode()
        headers["content-type"] = "application/x-www-form-urlencoded"
    elif data is not None:
        body = json.dumps(data).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return {"_error": e.code, "_detail": e.read().decode()[:600]}


def token():
    if not os.path.exists(CONFIGSTORE):
        die("no firebase login found. Run:  firebase login")
    with open(CONFIGSTORE) as f:
        refresh = (json.load(f).get("tokens") or {}).get("refresh_token")
    if not refresh:
        die("firebase config has no refresh token. Run:  firebase login --reauth")
    got = call("https://oauth2.googleapis.com/token", {
        "client_id": CLI_CLIENT_ID, "client_secret": CLI_CLIENT_SECRET,
        "refresh_token": refresh, "grant_type": "refresh_token",
    }, form=True)
    if "access_token" not in got:
        die("token refresh failed: %s" % got)
    return got["access_token"]


def main():
    log = sys.stderr.write
    tok = token()

    # 1. the account itself — idempotent, a second run just finds it
    got = call("https://iam.googleapis.com/v1/projects/%s/serviceAccounts" % PROJECT,
               {"accountId": ACCOUNT,
                "serviceAccount": {"displayName": "REMI dashboard reader",
                                   "description": "Read-only Firestore access for "
                                                  "the metrics dashboard workflow."}},
               token=tok)
    if got.get("_error") == 409:
        log("service account already exists — reusing %s\n" % EMAIL)
    elif got.get("_error"):
        die("could not create service account (%s)\n%s" % (got["_error"], got["_detail"]))
    else:
        log("created %s\n" % EMAIL)

    # 2. exactly one role, added without disturbing any existing binding
    policy = call("https://cloudresourcemanager.googleapis.com/v1/projects/%s:getIamPolicy"
                  % PROJECT, {}, token=tok)
    if policy.get("_error"):
        die("could not read IAM policy (%s)\n%s" % (policy["_error"], policy["_detail"]))

    member = "serviceAccount:" + EMAIL
    binding = next((b for b in policy.get("bindings", []) if b.get("role") == ROLE), None)
    if binding and member in binding.get("members", []):
        log("%s already granted\n" % ROLE)
    else:
        if binding:
            binding.setdefault("members", []).append(member)
        else:
            policy.setdefault("bindings", []).append({"role": ROLE, "members": [member]})
        # A freshly created account is not immediately visible to IAM, and
        # setIamPolicy answers "does not exist" for a few seconds. Retry rather
        # than leaving a half-configured account behind.
        for attempt in range(6):
            set_res = call("https://cloudresourcemanager.googleapis.com/v1/projects/%s:setIamPolicy"
                           % PROJECT, {"policy": policy}, token=tok)
            if not set_res.get("_error"):
                break
            if "does not exist" not in set_res.get("_detail", "") or attempt == 5:
                die("could not grant %s (%s)\n%s"
                    % (ROLE, set_res["_error"], set_res["_detail"]))
            wait = 2 * (attempt + 1)
            log("account not visible to IAM yet — retrying in %ds\n" % wait)
            time.sleep(wait)
        log("granted %s\n" % ROLE)

    # 3. the key — the only part that is a secret, so it goes to stdout alone
    key = call("https://iam.googleapis.com/v1/projects/-/serviceAccounts/%s/keys" % EMAIL,
               {"privateKeyType": "TYPE_GOOGLE_CREDENTIALS_FILE"}, token=tok)
    if key.get("_error"):
        die("could not create key (%s)\n%s" % (key["_error"], key["_detail"]))

    import base64
    sys.stdout.write(base64.b64decode(key["privateKeyData"]).decode())
    log("\nkey written to stdout — store it, then it is unrecoverable\n")


if __name__ == "__main__":
    main()
