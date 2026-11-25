# Deploy Polyboard

The dashboard runs as the `polymarket-dashboard.service` systemd unit, behind an HTTPS reverse proxy. Production uses a file-based release directory. Merging to GitHub does not deploy it.

## Access and baseline

- Use the server's Tailscale hostname or private IP for SSH from Codex Cloud. The public HTTPS hostname may resolve to an address the Tailscale TCP proxy cannot route. Check the Cloud Environment Runtime skill for the configured TCP forwarding method.
- Obtain the SSH login, trusted host fingerprint, and access through the operator's approved channel. A new chat may need its own authorized SSH identity. Keep keys and other credentials outside the repository.
- Check the service's actual code path and runtime with `systemctl show polymarket-dashboard -p WorkingDirectory -p ExecStart -p User`. Inspect the live files before copying anything. The production directory may have no Git metadata.
- Record the target Git commit. Compare the files you intend to replace against the last known deployed release and account for any server-only changes. Resolve unexpected differences before overwriting them.

## Stage and release

1. Run the tests and syntax checks in [AGENTS.md](../AGENTS.md). Export the affected runtime files from the target commit into a staging directory. Leave tests and repository metadata out of the live app directory.
2. Preserve the hosted `data-review-enabled` attribute on any dashboard HTML pages that already have it. Keep watchlist SQLite data, the VAPID key, and service configuration outside the release update. The private review worker is a separate systemd service. See the [README](../README.md#hosted-review-worker) if the release changes its code or configuration.
3. Save a timestamped backup of the live files being replaced and record its path. For newly introduced files, record that they were absent so they can be removed in a rollback. Use the existing staging and backup directories if the host provides them.
4. Install the staged files and restart the dashboard with `sudo systemctl restart polymarket-dashboard`. Allow the listener time to come up, then check `systemctl is-active polymarket-dashboard`. Use the port from `ExecStart` for local HTTP checks.

## Verify and roll back

- Check the affected route locally and through the public HTTPS site. Verify a marker for the feature and, where relevant, the served JavaScript and API response. For market search, check `/markets` for `catalog-suggestion-list` and query `/api/markets?q=bitcoin&suggest=1` for an `events` array.
- Check HTML by its expected content. `server.py` adds versioned asset URLs and can inject `data-market-thumbnails`, so served HTML can legitimately differ from the file on disk.
- If installation, restart, or smoke checks fail, restore replaced files from backup, remove files introduced by the failed release, restart the dashboard, and verify the restored routes. If diagnostics are needed, use `journalctl -u polymarket-dashboard`.
- Record the deployed commit, date, backup path, and checks in the deployment handoff. Keep private host and access details in the operator's records.
