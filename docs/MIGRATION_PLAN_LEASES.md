# Source migration plan leases over MCP

The old generic MCP sanitizer redacted every key containing `token`. This
included the non-authentication `planToken` returned by the reconstructed
editor's MovieClip migration preview. Direct HTTP worked, but MCP apply failed.

Only the direct `result.planToken` of a successful, typed independent-source
envelope is now preserved: valid contract/layer, non-native result, nonnegative
integer revision, string session, 32-character URL-safe lease, bounded positive
TTL <=120 seconds, and a migration with a 32-hex plan ID. Other token and
authorization fields retain redaction, including nested fields, error/native
envelopes and malformed leases. Actual configured secret occurrences are still
scrubbed from string content. This is output classification, not a new network
authentication boundary or permission system.

The source server still owns expiration, revision, project/resource identity,
staleness, one-use application and consumer proof checks. Historical receipt
replay returns the original metadata; it does not renew or reapply a lease.

The lease is a narrow typed value, not a reason to expose authentication credentials.
No native execution or complete editor parity is implied. External-backend integration
tests are separate from standalone/native transport tests.
