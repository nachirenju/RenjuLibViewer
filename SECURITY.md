# Android security update status — 2026-10-22

The source now requires `@capacitor/android` 7.6.9 or later to address
[CVE-2026-103922](https://github.com/ionic-team/capacitor/security/advisories/GHSA-rvm3-566m-v7fv).
The Android release build has been validated.

The APKs currently attached to older GitHub releases do not include this update.
A replacement APK signed with the original release certificate is not yet available:
the original signing credentials are required to preserve Android update compatibility.
Do not treat the source dependency update as an update to an already-installed APK.

Until a compatible signed update is available, avoid using the older Android APKs
with untrusted links. Disabling CapacitorHttp alone does not mitigate this advisory.

Maintainer/publisher name: `nachirenju`.