# Publishing the report archive

Every run writes its report into `publish/`, alongside a regenerated
`index.html` listing every report kept. Serving that directory behind a
password gives you a browsable archive instead of a stream of emails.

Nothing in this document contains a real host, path, or password. Fill those in
from your own `.env` and server configuration — **this repository is public.**

## Shape of it

```
publish/
  index.html                     archive listing, regenerated every run
  reports/
    report-2026-09-06T09-55.html one file per run
    report-2026-09-06T06-00.html
```

Two ways to get that onto the web server:

**A. The scanner runs on the web server.** Simplest. Point `publish.localDir`
at the directory nginx serves and leave `publish.upload.enabled` false — the
files are written straight into place, nothing is transferred.

**B. The scanner runs elsewhere** (a home PC, say) and uploads. Fill in
`VPS_HOST`, `VPS_USER`, `VPS_PATH` and `VPS_SSH_KEY` in `.env`, then set
`publish.upload.enabled` to true. Each run sends only the new report and the
refreshed index — a couple of hundred KB, not the whole archive.

## Access control

**The password must be enforced by the web server, not by the page.**

A password checked in client-side JavaScript is decoration: the browser has
already downloaded the page and everything in it before the check runs, and
anyone can read the password out of the source or skip straight to
`reports/report-….html`. The same applies to any "hide the content until the
right password is typed" scheme.

Use HTTP Basic Auth in nginx, which refuses the request before sending any
content, and put it on the directory so it covers the individual reports too —
not just the index.

Sketch, with your own values substituted:

```nginx
location /your-path/ {
    alias /var/www/your-directory/;
    index index.html;

    auth_basic           "Restricted";
    auth_basic_user_file /etc/nginx/.htpasswd-your-app;

    # Reports are regenerated three times a day; do not let a proxy or the
    # browser serve a stale one.
    add_header Cache-Control "no-store, must-revalidate";
    add_header X-Robots-Tag  "noindex, nofollow" always;
}
```

Create the password file with `htpasswd` (from `apache2-utils` /
`httpd-tools`). Use bcrypt (`-B`); the default algorithm is weak:

```bash
sudo htpasswd -B -c /etc/nginx/.htpasswd-your-app your-username
sudo chown root:www-data /etc/nginx/.htpasswd-your-app
sudo chmod 640 /etc/nginx/.htpasswd-your-app
```

### HTTPS is not optional here

Basic Auth sends the password base64-encoded, which is *encoding*, not
encryption — trivially reversible by anyone who can see the traffic. Over plain
HTTP the password is effectively sent in the clear on every request. Serve the
path only over HTTPS and redirect HTTP to it.

## Upload account

Give the upload its own SSH key and its own unprivileged user. The key sits on
whatever machine runs the scanner, so it should be able to do exactly one thing:
write into the publish directory.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/house_finder -C "house-finder upload"
```

Put the public half in the server user's `authorized_keys` and set
`VPS_SSH_KEY` to the private half. The uploader connects with
`BatchMode=yes`, so it fails fast rather than hanging on a prompt if the key is
wrong — which matters for an unattended 06:00 run.

Restrict the key in `authorized_keys`:

```
restrict ssh-ed25519 AAAA... house-finder upload
```

`restrict` disables port forwarding, agent forwarding, X11 and tty allocation.
The uploader only runs `scp` and non-interactive `ssh host 'command'`, neither of
which needs a tty, so no exception is required.

## Retention

`publish.keepDays` (default 60) and `publish.maxReports` (default 120) bound the
archive. Old reports are deleted locally, and the uploader mirrors that on the
server so it does not accumulate files forever. At three runs a day, 60 days is
roughly 180 reports of about 200 KB each — well under 40 MB.

## Checking it works

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/your-path/
# expect 401

curl -sS -o /dev/null -w '%{http_code}\n' -u user:pass https://your-host/your-path/
# expect 200

curl -sS -o /dev/null -w '%{http_code}\n' https://your-host/your-path/reports/
# expect 401 - the reports must be protected too, not just the index
```

That third check is the one people forget. If it returns 200 or a directory
listing, the auth block is on the wrong location and the reports are public.
