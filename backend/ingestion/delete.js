#!/usr/bin/env node
// ============================================================================
//  Deletes a hearing and everything that hangs off it (transcripts,
//  speaker_turns, and — via the same FK chain — comments/comment_quotes/
//  reports) in one transaction.
//
//  Relies on the ON DELETE CASCADE chain already wired in
//  001_initial_schema.sql: hearings.id -> transcripts.hearing_id ->
//  speaker_turns.transcript_id, so deleting the hearings row is sufficient —
//  no manual FK-ordered deletes needed.
//
//  Does NOT touch backend/ingestion/artifacts/ — that cache is content-
//  addressed (keyed by audio hash, not hearing id), so re-ingesting the same
//  audio after this delete is still a free, instant cache hit.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const hearingId = process.argv[2];
  if (!hearingId || !UUID_RE.test(hearingId)) {
    console.error('Usage: npm run ingest:delete -- <hearingId>');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const hearingRes = await client.query(`SELECT title FROM hearings WHERE id = $1`, [hearingId]);
    if (!hearingRes.rows.length) {
      console.error(`No hearing with id ${hearingId}.`);
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }
    const { title } = hearingRes.rows[0];

    const countsRes = await client.query(
      `SELECT
         (SELECT count(*) FROM transcripts WHERE hearing_id = $1) AS transcripts,
         (SELECT count(*) FROM speaker_turns st
            JOIN transcripts t ON t.id = st.transcript_id
            WHERE t.hearing_id = $1) AS turns`,
      [hearingId]
    );
    const { transcripts, turns } = countsRes.rows[0];

    await client.query(`DELETE FROM hearings WHERE id = $1`, [hearingId]);
    await client.query('COMMIT');

    console.log(`Deleted hearing ${hearingId} ("${title}")`);
    console.log(`  transcripts   : ${transcripts}`);
    console.log(`  speaker_turns : ${turns}`);
    console.log('  Deepgram artifact cache left untouched — re-ingesting this audio is still free.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Delete failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
