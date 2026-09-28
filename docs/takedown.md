# Taking down an assembly

This runbook removes an assembly that must no longer be shown. There is no
route or button for it: an operator with database access runs the steps below.

A takedown removes the content itself. The topic, the description and every
statement are overwritten, so nothing is left to show through any id or route
that still reaches the conversation.

Placeholders used below:

| Placeholder             | Meaning                                               |
| ----------------------- | ----------------------------------------------------- |
| `<ZID>`                 | Numeric id of the conversation in the database        |
| `<CONVERSATION_ID>`     | Public id, the last part of the assembly's URL        |
| `<REPORT_ID>`           | Id in a results URL, `/report/<REPORT_ID>`            |
| `<CONVERSATION_AT_URI>` | AT URI of the creator's conversation record           |
| `<CREATOR_DID>`         | DID of the account that created the assembly          |
| `<SERVICE_DID>`         | DID of the service account that holds seed statements |
| `<DATABASE_URL>`        | Connection string of a role that may write the tables |

You need `psql`, `curl` and `jq`, on a machine that can reach the database.
The log and the records list are written where `psql` runs. They hold the
removed content, so run `psql` in a directory only you can read, and if you
run it inside a container, copy both files out and delete them there.

## 1. Find the conversation

Use whichever id you were given. Each query returns the `<ZID>`.

```sql
SELECT zid FROM zinvites WHERE zinvite = '<CONVERSATION_ID>';
SELECT zid FROM reports WHERE report_id = '<REPORT_ID>';
SELECT zid FROM conversations WHERE at_uri = '<CONVERSATION_AT_URI>';
SELECT zid, at_uri FROM atproto_conversation_creations WHERE did = '<CREATOR_DID>';
```

Confirm you have the right one before you change anything:

```sql
SELECT zid, topic, is_active, created FROM conversations WHERE zid = <ZID>;
```

## 2. Remove the content

Start `psql "<DATABASE_URL>"` in a directory only you can read, then run the
block below as one transaction. It first copies the rows to the runbook log,
`takedown-<ZID>.jsonl` in the current directory.

```sql
\set ON_ERROR_STOP on
\set zid <ZID>

BEGIN;

\pset tuples_only on
\pset format unaligned
\o takedown-:zid.jsonl
SELECT row_to_json(r) FROM (SELECT 'conversations' AS table_name, c.* FROM conversations c WHERE c.zid = :zid) r;
SELECT row_to_json(r) FROM (SELECT 'comments' AS table_name, c.* FROM comments c WHERE c.zid = :zid ORDER BY c.tid) r;
SELECT row_to_json(r) FROM (SELECT 'zinvites' AS table_name, z.* FROM zinvites z WHERE z.zid = :zid) r;
SELECT row_to_json(r) FROM (SELECT 'reports' AS table_name, p.* FROM reports p WHERE p.zid = :zid ORDER BY p.rid) r;
\o
\pset format aligned
\pset tuples_only off

UPDATE conversations
   SET topic = '[removed]', description = '', modified = now_as_millis()
 WHERE zid = :zid;

UPDATE comments
   SET txt = '[removed statement ' || tid || ']', mod = -1, active = false, modified = now_as_millis()
 WHERE zid = :zid;

UPDATE conversations
   SET is_active = false, modified = now_as_millis()
 WHERE zid = :zid;

DELETE FROM zinvites WHERE zid = :zid;
DELETE FROM report_comment_selections WHERE rid IN (SELECT rid FROM reports WHERE zid = :zid);
DELETE FROM math_report_correlationmatrix WHERE rid IN (SELECT rid FROM reports WHERE zid = :zid);
DELETE FROM reports WHERE zid = :zid;

DELETE FROM comment_translations WHERE zid = :zid;
DELETE FROM conversation_translations WHERE zid = :zid;
```

The statement notice includes the statement's number because two statements
of one conversation cannot have the same text. If the second `UPDATE` fails on
`comments_zid_txt_key`, a statement already uses that exact notice: run
`ROLLBACK;` and start again with a different wording in that `UPDATE`.

Check the result while the transaction is still open:

```sql
\! wc -l takedown-<ZID>.jsonl

SELECT zid, topic, description, is_active FROM conversations WHERE zid = :zid;
SELECT tid, txt, mod, active FROM comments WHERE zid = :zid ORDER BY tid;
SELECT (SELECT count(*) FROM zinvites WHERE zid = :zid) AS zinvites,
       (SELECT count(*) FROM reports WHERE zid = :zid) AS reports,
       (SELECT count(*) FROM comment_translations WHERE zid = :zid) AS comment_translations,
       (SELECT count(*) FROM conversation_translations WHERE zid = :zid) AS conversation_translations;
```

The log must hold one line for the conversation plus one for each statement,
public id and report. The conversation must show the notice, an empty
description and `is_active = f`. Every statement must show its notice,
`mod = -1` and `active = f`. All four counts must be 0.

If anything differs, run `ROLLBACK;` and nothing has changed. Otherwise:

```sql
COMMIT;
```

Leave the conversation's row in `atproto_conversation_creations` in place. It
keeps the same record from creating the assembly again and it still counts
towards the creator's quota.

The log contains the removed content. Store it where takedown records are
kept and delete the local copy.

## 3. Wait one minute

The server keeps four lookups in memory: public id to conversation,
conversation to public id, report id to report, and the generated preview
image. Each entry expires 60 seconds after it was stored, so the takedown is
complete on the site one minute after the `COMMIT` without a restart.

The preview image is also served with a 24 hour `Cache-Control` header.
Browsers and other caches outside the server can keep showing the old image,
which contains the topic, for up to a day.

## 4. Delete the statement records from the service account

Seed statements are also published as records in the service account. List
the ones that belong to this conversation.

```sql
\set zid <ZID>
\pset tuples_only on
\pset format unaligned
\o takedown-:zid-records.txt
SELECT at_uri FROM comments
 WHERE zid = :zid
   AND at_uri LIKE 'at://<SERVICE_DID>/community.blacksky.assembly.statement/%'
 ORDER BY tid;
\o
\pset format aligned
\pset tuples_only off
```

Save the script below as `delete-statement-records.sh`. It reads the service
account's settings from the environment, under the names the server uses:
`ANON_PDS`, `ANON_HANDLE` and `ANON_APP_PASSWORD`. Export them in your shell
without writing them to a file or to your shell history.

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${ANON_PDS:?}" "${ANON_HANDLE:?}" "${ANON_APP_PASSWORD:?}"
export ANON_HANDLE ANON_APP_PASSWORD
records_file="${1:?usage: delete-statement-records.sh <records file>}"
collection="community.blacksky.assembly.statement"

session="$(jq -n '{identifier: env.ANON_HANDLE, password: env.ANON_APP_PASSWORD}' |
  curl -fsS --max-time 20 -X POST "$ANON_PDS/xrpc/com.atproto.server.createSession" \
    -H 'Content-Type: application/json' --data-binary @-)"
did="$(jq -er .did <<<"$session")"
auth_header="Authorization: Bearer $(jq -er .accessJwt <<<"$session")"

remaining=0
while IFS= read -r uri; do
  [ -n "$uri" ] || continue
  case "$uri" in
    "at://$did/$collection/"*) ;;
    *)
      echo "not in the service account, skipped: $uri"
      remaining=$((remaining + 1))
      continue
      ;;
  esac
  rkey="${uri##*/}"

  jq -n --arg repo "$did" --arg collection "$collection" --arg rkey "$rkey" \
    '{repo: $repo, collection: $collection, rkey: $rkey}' |
    curl -fsS --max-time 20 -X POST "$ANON_PDS/xrpc/com.atproto.repo.deleteRecord" \
      -H @<(printf '%s\n' "$auth_header") -H 'Content-Type: application/json' \
      --data-binary @- >/dev/null

  answer="$(curl -sS --max-time 20 -G "$ANON_PDS/xrpc/com.atproto.repo.getRecord" \
    --data-urlencode "repo=$did" --data-urlencode "collection=$collection" \
    --data-urlencode "rkey=$rkey")"
  if [ "$(jq -r '.error? // empty' <<<"$answer")" = "RecordNotFound" ]; then
    echo "gone: $uri"
  else
    echo "NOT CONFIRMED GONE: $uri"
    remaining=$((remaining + 1))
  fi
done <"$records_file"

echo "$remaining record(s) need attention"
[ "$remaining" -eq 0 ]
```

```bash
bash delete-statement-records.sh takedown-<ZID>-records.txt
```

Deleting a record that is already gone succeeds, so the script can be run
again at any time. After each deletion it asks for the record and expects the
answer `RecordNotFound`. It exits with an error when a record could not be
deleted, when a record is not confirmed gone, or when a line of the file is
not a statement record of the service account.

## 5. Check again a minute later

A write that was already on its way when the transaction committed can land
after it. Wait at least one minute after step 4, then:

1. Run this query. It must return no rows. If it returns rows, run the
   `UPDATE comments` statement of step 2 again. In a new `psql` session run
   `\set zid <ZID>` first, because that statement uses the variable.

   ```sql
   SELECT tid FROM comments
    WHERE zid = <ZID>
      AND (active OR mod <> -1 OR txt <> '[removed statement ' || tid || ']');
   ```

2. Create the list of step 4 again, so that it includes a record whose
   address was stored in the meantime.
3. Run the script of step 4 again. Every line must read `gone`.

## Scope

This removes the primary copies: the conversation and its statements in the
database, the ids and report pages that lead to them, stored translations,
and the statement records in the service account.

It does not remove:

- Copies made by optional analysis features (Delphi output and collective
  statements in DynamoDB). They only exist when a team member ran those jobs
  for the conversation. Purging them is a separate task. Do not use
  `delphi/umap_narrative/reset_conversation.py` for it: that script matches
  conversation ids by prefix, so resetting conversation `12` also deletes
  analysis results of `120` to `129`, `1200` and so on.
- Records in other accounts: the conversation record and the post in the
  creator's account, statement records that participants published from
  their own accounts, and the vote records in the voters' accounts. Those are
  handled by moderation of the account or the record.
- Copies of the preview image held outside the server (see step 3).

## Undoing a takedown

Nothing restores a takedown automatically. The runbook log holds the original
rows of `conversations`, `comments`, `zinvites` and `reports`, which is enough
to restore them by hand. The deleted statement records would have to be
written again.
