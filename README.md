# live config
Served to Rebound for Twitch extensions from raw.githubusercontent.com. Written only by
the publish-config / rollback-config workflows. `config.json.sig` is an Ed25519 signature
over the exact bytes of `config.json`; extensions reject anything that does not verify.
