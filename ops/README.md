# BlockDust ops: hardening & tuning

Hardening and tuning for the marketplace host.

Deployed 2026-08-18: backend loopback bind, PostgreSQL tuning, nginx upstream
keepalive, and CrowdSec firewall enforcement. Each section records what was
found, what was changed, and how it was verified.

Still outstanding: the public database credential (see "Not addressed here").

---

## 1. Backend network exposure (APPLIED — code change)

`backend/server.js` called `app.listen(PORT, ...)` with no bind address, so
Node bound `0.0.0.0` — every interface — while logging `http://127.0.0.1:8787`.
The API was reachable directly on the host's LAN addresses, which bypassed:

* every nginx `limit_req` rate limit (`/api/db` 5r/s, `/api/rpc` 5r/s, sync 1r/s)
* every security header (HSTS, X-Frame-Options, nosniff, Referrer-Policy)
* the nginx proxy cache in front of `/api/ipfs` and `/api/media`

Verified before the fix:

```
$ curl -o /dev/null -w '%{http_code}' http://192.168.1.113:8787/api/health
200
$ for i in $(seq 10); do curl -o /dev/null -w '%{http_code} ' \
    http://192.168.1.113:8787/api/health; done
200 200 200 200 200 200 200 200 200 200      # no 429 — limits bypassed
```

Now binds `127.0.0.1` by default. Override with `BIND_HOST` only if something
other than the local nginx fronts the process.

**Deploy:** `sudo systemctl restart blockdust-backend`

Confirm afterwards, from another machine on the LAN:

```
curl -m 5 http://<host-lan-ip>:8787/api/health    # should refuse
curl -m 5 https://blockdust.pyvendr.com/api/health?format=json   # should work
```

---

## 2. PostgreSQL tuning (APPLIED)

`10-blockdust-tuning.conf`

Postgres 16 was running entirely at package defaults on a 24-core / 62 GB /
NVMe host — `shared_buffers = 128MB`, and `random_page_cost = 4.0`, which
assumes a spinning disk and steers the planner away from the 19 indexes in
`backend/db/schema.sql`.

```bash
sudo cp ops/10-blockdust-tuning.conf \
        /etc/postgresql/16/main/conf.d/10-blockdust-tuning.conf
sudo systemctl restart postgresql
```

`conf.d` is already active via `include_dir = 'conf.d'` in
`postgresql.conf`, so no other edit is needed.

> This Postgres server is shared with sibling projects (BlockDust has its own
> database on it, not its own server). These are server-wide settings and the
> restart drops other projects' connections — pick the moment.

Verify:

```sql
SELECT name, setting, unit FROM pg_settings
WHERE name IN ('shared_buffers','effective_cache_size','random_page_cost');
```

---

## 3. nginx upstream keepalive + connection limits (APPLIED)

`blockdust-upstream.conf`, plus edits already made to
`blockdust-site.nginx.conf` in this repo.

Every proxied request opened a fresh TCP connection to the backend. The site
config now targets a keepalive pool and caps concurrent connections per IP
(`limit_req` bounds rate; `limit_conn` bounds simultaneous connections, which
is what slow-loris style clients abuse).

```bash
sudo cp ops/blockdust-upstream.conf /etc/nginx/conf.d/blockdust-upstream.conf
sudo cp blockdust-site.nginx.conf /etc/nginx/sites-available/blockdust
sudo nginx -t && sudo systemctl reload nginx
```

Both files must land together — the site block references
`upstream blockdust_backend` and `zone=blockdust_conn_per_ip`, and nginx
fails to start if either is missing.

Config was syntax-checked in isolation (`nginx -t` against a scratch prefix);
it parsed clean, with only permission errors for the root-owned pid and log
paths.

---

## 4. Host firewall & WAF (RESOLVED — see correction)

**An earlier version of this file claimed the host had no firewall. That was
wrong.** The claim came from running `ufw status` without root, getting a
permission error, and misreading it as "not installed". `ufw.service` was
active the whole time.

`harden-firewall.sh` in this directory was written under that mistaken
assumption. **Do not run it.** It assumes a bare host and would rewrite policy
that is already in place, potentially conflicting with the fail2ban chains.
It is kept only as a reference for what a from-scratch ruleset would look like.

### What is actually running

* **ufw** — active.
* **fail2ban** — active, with `sshd`, `nginx-env-scan`, and `nginx-enumerator`
  jails enabled.
* **CrowdSec** 1.4.6 (Ubuntu archive build) — collections enabled for
  `nginx`, `http-cve`, `base-http-scenarios`, `sshd`, `apache2`, `linux`.
* **crowdsec-firewall-bouncer** 0.0.25 — installed and enforcing.

### The gap that was found and closed

CrowdSec was running in **detection only** mode: the engine was parsing nginx
logs and generating decisions, but no bouncer was installed, so nothing
enforced them. Flagged IPs were never actually blocked.

Two things to know if this host is ever rebuilt:

1. **Package name.** Upstream's docs say
   `crowdsec-firewall-bouncer-iptables`; that package does not exist in
   Ubuntu. Ubuntu ships a single `crowdsec-firewall-bouncer` that depends on
   nftables *or* iptables+ipset.

2. **`mode: ${BACKEND}` is not substituted.** The Ubuntu package ships
   `/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml` with a literal
   `${BACKEND}` placeholder, and nothing fills it in — there is no
   `Environment=` line in the unit and no `/etc/default/` file. The bouncer
   still passes `-t` validation and starts without error, so this fails
   silently. Set it explicitly:

   ```bash
   sudo sed -i 's/^mode: .*/mode: nftables/' \
       /etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml
   sudo systemctl restart crowdsec-firewall-bouncer
   ```

   `nftables` is the right mode here: the host uses `iptables-nft`, and
   nftables mode gives CrowdSec its own tables instead of injecting rules into
   the chains ufw manages.

### Verified enforcing

```
$ sudo cscli bouncers list
 FirewallBouncer-tKqn…   127.0.0.1   ✔️   2026-08-18T23:24:52Z   api-key

$ sudo nft list ruleset | grep -i crowdsec
table ip crowdsec {
        set crowdsec-blacklists {
        chain crowdsec-chain {
                ip saddr @crowdsec-blacklists counter packets 0 bytes 0 drop
table ip6 crowdsec6 { … }
```

A valid bouncer with a current "last API pull", and both IPv4 and IPv6 tables
present. `packets 0` is the correct resting state — the sets are empty until
a scenario fires.

Re-check after any CrowdSec upgrade, since the `${BACKEND}` placeholder can
come back with a repackaged config.

---

## Already correct — no change made

* **PostgreSQL is loopback-only** (`127.0.0.1:5432`); the database is not
  network-exposed.
* nginx global config is sane: `worker_processes auto`,
  `worker_rlimit_nofile 65535`, `multi_accept on`, gzip configured.
* The `/api/ipfs` and `/api/media` proxy cache (365d, `proxy_cache_lock`,
  `use_stale` on upstream errors) is well built.
* `.ipfs-cache` sits under the webroot but is a dotfile, and
  `snippets/block-dotfiles.conf` returns 444 for it.
* `app.disable('x-powered-by')` is already set.

## Not addressed here

* **The Postgres password is committed to a public git repo.**
  `backend/blockdust-backend.service` is tracked and contains a literal
  `Environment=DATABASE_URL=postgresql://hyvedash:<password>@127.0.0.1:5432/blockdust`,
  and `origin` is a public GitHub repository. The same default is hardcoded as
  a fallback in `backend/db/pgClient.js`.

  Postgres only listens on loopback, so this is not remotely exploitable on
  its own — but the credential is public and should be treated as compromised.
  Handling it is a sequence, not a one-liner:

  1. Rotate the role password in Postgres.
  2. Move the connection string to an `EnvironmentFile=/etc/blockdust/backend.env`
     (`chmod 0600`, owned by root) and drop the `Environment=DATABASE_URL` line.
  3. Replace the hardcoded fallback in `backend/db/pgClient.js` with a
     startup error when `DATABASE_URL` is unset.
  4. Purge from history (`git filter-repo`) or accept that the old value stays
     in the public log — rotation in step 1 is what actually closes it.

  Left for you: rotating a live credential mid-session would break the running
  backend and any sibling project sharing the role.
* No `Content-Security-Policy` header. Adding one to a wallet-connecting SPA
  needs testing against the wallet SDKs, so it is not a drop-in.
