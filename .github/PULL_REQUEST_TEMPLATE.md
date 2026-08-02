## Why / observed behavior

## Operator path

## Behavior / integration contract

## Scope

## Research / context

## Coordination

## Tests first

## TDD trail

- Red commit and command:
- Green commit and command:

## Risk

## Deploy / rollback

## Docs / handoff

## Lineage contract

All work starts with an Epic and a PR-sized native GitHub subissue before
implementation.

`main` PRs use GitHub native `closingIssuesReferences`: exactly one closing
issue, with both that issue and its native Epic parent in this repository.
`dev` PRs must contain exactly one standalone same-repository `Closes #N` line.
The referenced issue is queried and must be a native child of a same-repository Epic
labeled `epic`; cross-repository, malformed, or extra closing references fail
closed. Development-only work stays on `dev` and must never be retargeted to or merged into `main` without explicit future approval.

## Definition of done

- [ ] The implementation issue is a native child of the stated same-repository Epic
- [ ] `main`: exactly one native closing issue reference
- [ ] `dev`: exactly one standalone `Closes #N` line and no other closing keyword
- [ ] Development-only work remains on `dev`; no `main` retarget or merge is authorized
- [ ] Tests and required checks pass
