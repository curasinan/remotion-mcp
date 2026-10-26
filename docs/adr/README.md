# Architecture Decision Records

Accepted ADRs are never edited.
- A successor states its relation to an earlier ADR in a **Relation** line under
  its **Status**. It quotes the clause it reverses, cited by number where the
  earlier ADR numbers it and by line otherwise.
- This index is where status is tracked. An ADR's own Status line records the
  status it landed with. The Relation column records how each ADR relates to
  the others, including any relation that arose after it landed.
- A Proposed ADR's Status line changes once, when its stated gate is met.

ADRs 0004, 0006 and 0007 were corrected in place before they reached `main`, per
owner ruling 4 of 2026-10-26. ADR-5's boundary was restated in place per owner
ruling 7 of the same date. Both rulings are in design §1, in
[the v2 design](../superpowers/specs/2026-10-26-service-profile-v2-design.md).
Merging PR #18 is their acceptance.

| ADR | Decision | Status | Relation |
| --- | --- | --- | --- |
| [0001](0001-transport-stdio-only.md) | stdio only, no HTTP transport | Accepted | Partly superseded by 0004: the service profile has HTTP; the `.mcpb` stays stdio only |
| [0002](0002-no-gateway.md) | No gateway | Accepted | Partly superseded by 0006: a gateway fronts the service profile |
| [0003](0003-isolation-boundary.md) | Isolate the in-process native code, no container | Accepted | Completed by 0007, for the service profile |
| [0004](0004-http-transport-for-the-service-profile.md) | HTTP transport for the service profile; the `.mcpb` stays stdio only | Accepted | Partly supersedes 0001 |
| [0005](0005-tool-profiles-and-template-packs.md) | Two tool profiles, separated structurally; the service renders only a baked template pack | Accepted | Builds on 0004 |
| [0006](0006-gateway-for-the-service-profile.md) | The service profile trusts only the owner's gateway | Accepted | Partly supersedes 0002 |
| [0007](0007-process-isolation-for-rendering.md) | Spawn the Remotion CLI directly and kill every process group it creates | Accepted | Completes 0003 |
