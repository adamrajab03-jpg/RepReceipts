#!/usr/bin/env node
// ============================================================================
//  Lists every hearing with its status and turn count, so orphans and dupes
//  left behind by ingestion runs are easy to spot.
// ============================================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(`
      SELECT h.id, h.title, h.status, h.video_url, h.created_at,
             count(st.id) AS turn_count
      FROM hearings h
      LEFT JOIN transcripts t    ON t.hearing_id = h.id AND t.source = 'deepgram_batch'
      LEFT JOIN speaker_turns st ON st.transcript_id = t.id
      GROUP BY h.id
      ORDER BY h.created_at DESC
    `);

    if (!rows.length) {
      console.log('No hearings found.');
      return;
    }

    console.log('ID'.padEnd(38) + 'STATUS'.padEnd(14) + 'TURNS'.padEnd(7) + 'TITLE');
    for (const r of rows) {
      const label = r.video_url ? `${r.title}  [${r.video_url}]` : r.title;
      console.log(
        String(r.id).padEnd(38) +
        String(r.status).padEnd(14) +
        String(r.turn_count).padEnd(7) +
        label
      );
    }
    console.log(`\n${rows.length} hearing(s).`);
  } finally {
    await pool.end();
  }
}

main();
