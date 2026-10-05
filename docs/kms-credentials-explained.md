# The KMS credentials, explained

**Who this is for:** anyone who has to set up, review, rotate or explain Cashping's custody
credentials without an AWS background — a developer joining the project, a stakeholder signing off
a launch, or the next person who has to answer "what can this credential actually do?".

Nothing here is new policy. It is the same rule the repository already enforces, said in plain
words. The specification is `README.md` → *What the KMS credentials are allowed to do*; the code it
describes is `src/wallet/custody/`; the deployment side is
`docs/pre-production-hardening.md` §3.0(b). Where this document and those disagree, they win.

---

## 1. What is being protected

Cashping is custodial: the app holds every user's Stellar wallet on their behalf, in the same way a
bank holds the money in your account. For that to work, the app has to be able to *sign* payments
from a user's wallet — and signing needs the wallet's **secret key** (the Stellar term is the
*seed*: a short string, like `SB…`, that is the entire proof of ownership of that wallet).

That one string is the thing this document is about. Everything else in the system — the phone
number, the handle, the balance display — is either public or replaceable. The seed is neither:

- Anyone who reads it can move that wallet's funds. There is no password reset, no support call and
  no bank to call back; a signed Stellar payment is final.
- It cannot be regenerated. Lose it and the wallet is gone — the public key still exists on the
  network, but nothing can spend from it ever again.
- It is the *only* piece of data in the product whose leak costs a specific user money directly,
  rather than costing reputation or convenience.

So the security question for this product is narrow and concrete: **who can read a seed?** The rest
of this document is how that is limited to "a running Cashping process that was asked to sign
something".

## 2. Why we do not store it in plain form

If a seed sat in the database as readable text, then anyone holding a database dump would hold every
user's wallet. That is a single accident — a backup copied to the wrong place, a laptop, a
mis-scoped read replica, one SQL injection — away from total loss, and it would be a loss the users
cannot be told about fast enough to do anything about.

So no seed is stored readable. Each one is sealed, and what is in the database is a blob that only
works if AWS KMS agrees to help open it (the format is
`cp-kms-1.<wrapped key>.<iv>.<tag>.<ciphertext>`, and `src/wallet/custody/secret-envelope.ts` is the
only thing that understands it).

### Why KMS, and not a scheme we write ourselves

Encrypting data is not hard. Keeping the *key to the encryption* safe is the hard part, and that is
the entire reason a service like AWS KMS exists rather than a clever idea in a config file:

- **The key that matters never leaves AWS.** Cashping stores a *data key* per wallet, and that data
  key is itself encrypted by a **master key that lives in KMS** and is never exported, in any
  scenario. A dumped database therefore contains nothing that can be opened without an AWS call. A
  homemade scheme has to keep *its* key somewhere the app can reach — which is somewhere a person
  who already has the app's environment can reach too.
- **It is a vault that has been attacked on our behalf.** AWS's master keys run in hardware (HSMs),
  are audited, and the "how" is AWS's problem to defend and to keep current. The realistic
  alternative for a solo developer under time pressure is a key in an environment variable and a
  note somewhere saying "rotate this" — a design that looks identical on the happy path and fails
  completely on the one path that matters.
- **Access is a permission, not a copy.** Using the master key requires the app to authenticate as an
  identity that has been granted exactly that right, and that grant can be revoked in seconds. If
  the credential leaks, we revoke it and the leaked string is worthless. If a self-managed key
  leaks, the only fix is re-encrypting everything — and every seed that was read before the fix is
  still gone.
- **Every use is recorded.** KMS logs calls, so "who unwrapped this wallet's key, when, and from
  where" is answerable. Cashping keeps its own trail too (the audit log, `src/audit/`), but that
  trail is ours — and a log whose author is also the only thing it can incriminate is weaker
  evidence than one kept elsewhere.

Two honest caveats, because a document that lists only the upside is a sales pitch:

- KMS is a dependency. If KMS is unreachable, signing stops. Cashping treats that as a temporary
  outage (retry) rather than as corruption, and the wallet fails closed — see the failure table in
  `README.md`.
- The master key is currently **fixed**: nothing in this application re-wraps an existing wallet
  under a new one, so disabling or rotating the master key strands every wallet sealed under it.
  That is a real limitation, recorded in `README.md` and in `docs/pre-production-hardening.md`
  §3.0(b), and it is one of the findings in `docs/mvp-completion-audit.md`. Rotating the *access
  key* (§3 below) is safe and is the correct response to a leaked credential.

## 3. What the IAM user is

The deployed app has to prove to AWS who it is before KMS will do anything. It does that with a pair
of strings — `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` — that belong to an **IAM user**.

**An IAM user here is not a person.** It has no login, no console access, no password, and nobody
signs in as it. It is an *identity for a service*: a name AWS recognises so that it can answer one
question — "is this caller allowed to do this particular thing to this particular key?" — and so
that the answer can be taken away later without touching anything else.

Cashping's identity is `cashping-staging-custody` (one per environment: staging and any future
mainnet setup must not share one). Three properties of it are load-bearing:

- **It uses a long-lived access key, not a temporary one.** Both values are read with `getOrThrow`,
  and nothing in `src/` reads `AWS_SESSION_TOKEN`, a shared-config profile, or instance metadata. So
  the identity must be one that *can* hold a long-lived key — which for AWS means an IAM user, not a
  role. This is also why a working laptop login proves nothing about what the deployed service can
  do: the service reads two strings from its environment and nothing else.
- **It is offered by the app only to KMS.** `@aws-sdk/client-kms` is the only `@aws-sdk` package in
  `package.json`, so no other AWS service belongs in its permissions. A future change that adds one
  is a deliberate widening of this boundary, and should be argued for on its own merits.
- **It can do nothing to the key except use it.** It cannot create, disable, delete, tag or grant
  keys. A credential that could disable the key it depends on is a credential that could strand
  every wallet at once.

## 4. What the three permissions do, in plain terms

The app makes exactly three calls to KMS, from exactly one file
(`src/wallet/custody/kms-key-wrapper.ts` — the only file in the repository that imports the AWS KMS
client). In plain language:

| Permission | Plain terms | When it happens |
| --- | --- | --- |
| `kms:GenerateDataKey` | **Mint the key for a new wallet.** AWS creates a fresh random AES-256 key, wraps it with the master key, and hands back only the wrapped copy. Directly underneath: the plaintext of that new key exists for the duration of the call; it is never stored on our side. | Once per wallet, when a wallet is first provisioned |
| `kms:Decrypt` | **Unlock a wallet so it can sign.** AWS unwraps that wallet's data key, and the app uses it to decrypt the seed in memory, build and sign the payment, then discard it. | Once per payment, immediately before signing |
| `kms:DescribeKey` | **Check the key is healthy at startup.** AWS confirms the configured key exists, is enabled, and is in the region the app is configured for. | Once at boot |

`kms:Encrypt` is deliberately **not** granted. It is the permission that looks obviously necessary
and is not: the seed is sealed locally with the data key, so KMS only ever wraps and unwraps the
data key itself. Nothing here creates, schedules, tags, grants, re-encrypts or deletes a key.

### Why exactly these three, on exactly one key

This is the principle of least privilege: give a credential the smallest set of abilities that lets
the job be done, so that when it is stolen the damage has a ceiling.

- **Why not `kms:*` on the key?** Because the credential's job is to *use* one key, not to
  administer it. Key administration includes deleting and disabling. A leaked `kms:*` credential can
  destroy the ability to sign for every wallet in one call, which is a worse outcome than the theft
  it started as, and it would be unrecoverable.
- **Why not `Resource: "*"`?** Because a wildcard turns every key in the account (and every key
  anybody adds later) into something this credential can open. Scoping to the one key ARN means a
  leaked credential can only ever touch the key that wraps this deployment's wallets — it cannot
  reach a second environment, a future mainnet key, or anything else in the AWS account.
- **Why not a fourth permission "just in case"?** Because permissions are discovered the same way
  outages are: the first person who needs one adds it knowingly. An unused grant is not safety
  margin; it is an ability that exists only for an attacker, since the app never calls it.
- **Why is the missing `DescribeKey` special?** It is the one omission that fails *quietly*. An IAM
  denial arrives as `AccessDeniedException`, which this code classifies as "KMS unavailable" rather
  than "the key is broken" — deliberately, so a real outage does not send someone to inspect key
  material. The consequence is that a policy without `DescribeKey` still starts, still signs, and
  prints a boot line that reads like a dead key, while the three failures the probe exists to catch
  (wrong region, deleted key, disabled key) go back to being found one wallet at a time, later. See
  `README.md` → *What the KMS credentials are allowed to do* for the full argument and the tests
  that pin it.

## 5. The policy, annotated

The policy is attached to the IAM user as an **inline** policy (it lives on the user, not as a
shared managed document), named `CashpingSeedCustody`. Every line below is annotated for a reader.

JSON has no comments, so the blocks below are two views of the same document: the first is for
reading, and the second is what you would actually paste. They must not drift — the annotated copy
is the one that is wrong if they ever disagree with `README.md`.

```jsonc
{
  "Version": "2012-10-17",              // The current IAM policy language version. Not a date to update.
  "Statement": [
    {
      "Sid": "CashpingSeedCustody",     // A label for this statement. It appears in audit logs and in error messages.
      "Effect": "Allow",                // Allow, and nothing else: no statement denies anything,
                                        //   because everything not allowed is already denied.
      "Action": [
        "kms:GenerateDataKey",          // Mint + wrap a new wallet's data key (provisioning).
        "kms:Decrypt",                  // Unwrap this wallet's data key so it can sign (per payment).
        "kms:DescribeKey"               // Prove the key resolves, in this region, at boot.
      ],
      "Resource": "arn:aws:kms:<AWS_REGION>:<account-id>:key/<key-id>"
                                        // One key, and only one: the master key that wraps every
                                        //   wallet's data key. Never "*" and never a second ARN.
                                        //   Note this is the key's ARN even when AWS_KMS_KEY_ID is
                                        //   an alias or a bare key id - resolve it first, because a
                                        //   policy written against an alias name is not this policy.
    }
  ]
}
```

The same thing, ready to paste (fill in the two placeholder parts, which must agree with
`AWS_REGION` and `AWS_KMS_KEY_ID` in the environment):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CashpingSeedCustody",
      "Effect": "Allow",
      "Action": ["kms:GenerateDataKey", "kms:Decrypt", "kms:DescribeKey"],
      "Resource": "arn:aws:kms:<AWS_REGION>:<account-id>:key/<key-id>"
    }
  ]
}
```

**Editing it means editing *this* policy.** Do not add a second one beside it. A second inline
managed policy is not a backup or a way to stage a change — IAM grants the *union* of every policy
a user holds, so adding a new three-action policy while the old one (possibly a two-action policy,
possibly with `Resource: "*"`) is still attached grants more permission than before, not the same
amount. If a second policy is ever created deliberately, delete the first one in the same change,
and read the result back rather than assuming it.

## 6. How to verify this is still correctly scoped

Policy drifts the moment somebody edits it in the console to unblock themselves, and the drift is
invisible from the outside: the app keeps working, because a wider policy never breaks anything.
So the check is a read, and it should be run after any IAM change and before any launch — and it
should be run with a principal that is allowed to *read* IAM, never with the custody credential
itself (which cannot read IAM, and should not be able to).

```bash
# Read-only sweep. Nothing here writes.
USER_NAME=cashping-staging-custody

echo "== inline policies on $USER_NAME (expect exactly one: CashpingSeedCustody) =="
aws iam list-user-policies --user-name "$USER_NAME" --query 'PolicyNames' --output text

echo "== attached managed policies (expect nothing at all) =="
aws iam list-attached-user-policies --user-name "$USER_NAME" \
  --query 'AttachedPolicies[].PolicyArn' --output text

echo "== the document, in full =="
for policy in $(aws iam list-user-policies --user-name "$USER_NAME" --query 'PolicyNames' --output text); do
  echo "--- $policy"
  aws iam get-user-policy --user-name "$USER_NAME" --policy-name "$policy" \
    --query 'PolicyDocument' --output json
done
```

Reading the output is the check, but two assertions make it pass/fail rather than a judgement call —
the first that nothing else is attached, the second that the one document is exactly what §5 shows:

```bash
# 1. Exactly one inline policy, and no managed policy. Prints "1" and an empty line.
aws iam list-user-policies --user-name "$USER_NAME" --query 'length(PolicyNames)' --output text
aws iam list-attached-user-policies --user-name "$USER_NAME" \
  --query 'length(AttachedPolicies)' --output text

# 2. The document itself: one statement, Allow, exactly these three actions, one key ARN.
aws iam get-user-policy --user-name "$USER_NAME" --policy-name CashpingSeedCustody \
  --query 'PolicyDocument' --output json | jq -e '
    (.Statement | length) == 1
    and .Statement[0].Effect == "Allow"
    and ((.Statement[0].Action | if type == "array" then sort else [.] end)
         == ["kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey"])
    and (.Statement[0].Resource | type == "string")
    and (.Statement[0].Resource
         | test("^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]{36}$"))
  ' && echo SCOPED || echo "REVIEW: not the three actions on one key ARN"
```

### What a bad result looks like

Any one of these means the sweep found something worth acting on:

| What you see | Why it is bad |
| --- | --- |
| **More than one inline policy name.** | Both are in force. IAM grants the union, so the narrow policy you are reading is not the effective one — the other one is, added to it. |
| **A non-empty attached managed policies list.** | Same union problem, and this is the specific failure the sweep exists to catch: a leftover custody policy with `Resource: "*"` or two actions is still granting, and it grants *more* than the policy above it. |
| **`"Resource": "*"`, an array of ARNs, or `…:key/*`.** | The credential can open keys it has no business opening — another environment's, a future mainnet key's, anything added later. This is the one that turns a leaked credential from "one deployment's wallets" into "whatever it can reach". |
| **An action that is not the three.** `kms:Encrypt`, `kms:ReEncrypt*`, `kms:CreateKey`, `kms:TagResource` are needless; `kms:*`, `kms:DisableKey`, `kms:ScheduleKeyDeletion` or `kms:PutKeyPolicy` are strictly worse — a credential that can disable or delete its own key can strand every wallet at once. |
| **`kms:Decrypt` on a different ARN from `AWS_KMS_KEY_ID`.** | The app still runs and every signature fails, reported as tampering (`IncorrectKeyException`) rather than as a misconfiguration — the most confusing failure in the custody path. |
| **`"Effect": "Deny"`, or a `Condition` that is never true.** | The policy reads restricted and is in fact a denial: boot loses its probe, and the first payment fails. |

The fix for any of these is the same and is not a new policy: replace the document in place with
§5's version, delete anything else attached to the user, then run the sweep again and read the
document back. A grant that has been read back is evidence; a grant that was written is a hope.

## 7. Where this is enforced, and what to read next

Nothing above is enforced by documentation. The code is the specification, and these are the files
that hold the rule:

| Where | What it settles |
| --- | --- |
| `src/wallet/custody/kms-key-wrapper.ts` | The only file that imports `@aws-sdk/client-kms`, and therefore the list of calls the policy has to allow: three. It also holds the boot probe, and the classification that makes a denied `DescribeKey` look like an outage. |
| `src/wallet/custody/secret-envelope.ts` | The stored format, and the two places a wallet's id is bound into the ciphertext — which is why a blob moved to another row fails locally *and* at KMS. |
| `src/wallet/custody/seed-custody.service.ts` | The API the rest of the app uses. It logs nothing, deliberately, and hands out a keypair rather than a string. |
| `src/config/validation.schema.ts` | Boot refuses an obviously-placeholder `AWS_KMS_KEY_ID`, and refuses `AWS_ENDPOINT_URL` outright in production. |
| `docker-compose.yml` | A shape-valid placeholder ARN, so a fresh clone starts with the wallet failing *closed* rather than the container refusing to boot. |
| `src/wallet/custody/kms-key-wrapper.spec.ts` | Pins the classifications (`AccessDenied`, `Throttling`, `ExpiredToken`) and the boot-probe cases. `npm test` runs it offline: the AWS client sits behind `KEY_WRAPPER` / `KMS_CLIENT_FACTORY`. |

Further reading, in the order that makes sense:

- `README.md` → *Stellar key custody (Step 18)* — the envelope, the failure table, and
  *What the KMS credentials are allowed to do*, which is the specification for this document.
- `docs/pre-production-hardening.md` §3.0(b) — the same rule from the deployment side: which values
  a Render sync prompts for, why the key must be in `AWS_REGION`, and the master-key rotation limit.
- `docs/frontend-auth-flow.md` §1 — for a frontend reader: this is the server-side machinery behind
  the `Authorization` header, and nothing a client ever sees or sends.
- `docs/mvp-completion-audit.md` — what is still missing around custody, with the gaps named rather
  than implied. The two that touch this document are the absent key-recovery procedure and the fact
  that a leaked credential is rotated while a leaked master key cannot be.

In one sentence: **the custody credential may mint a data key for a new wallet, unlock a wallet's
data key to sign, and check the key at boot — on one key, in one region, and nothing else.**
