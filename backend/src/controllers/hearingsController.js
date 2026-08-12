const db = require('../utils/db');

async function listHearings(req, res) {
  try {
    const { committee_id, status, congress, topic, member } = req.query;

    const conditions = [];
    const params = [];

    if (committee_id) {
      params.push(committee_id);
      conditions.push(`h.committee_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`h.status = $${params.length}`);
    }
    if (congress) {
      params.push(parseInt(congress, 10));
      conditions.push(`h.congress = $${params.length}`);
    }
    if (topic || member) {
      const sub = [];
      let join = '';
      if (topic) {
        params.push(topic);
        join += `
          JOIN turn_topics tt ON tt.turn_id = st.id
          JOIN topics      t  ON t.id = tt.topic_id
        `;
        sub.push(`t.slug = $${params.length}`);
      }
      if (member) {
        params.push(member);
        sub.push(`st.member_id = $${params.length}`);
      }
      conditions.push(`EXISTS (
        SELECT 1
        FROM   transcripts tr
        JOIN   speaker_turns st ON st.transcript_id = tr.id
        ${join}
        WHERE  tr.hearing_id = h.id AND ${sub.join(' AND ')}
      )`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT
        h.id, h.title, h.congress, h.held_on, h.status,
        h.video_url, h.video_source, h.official_url, h.created_at,
        c.id   AS committee_id,
        c.name AS committee_name,
        c.chamber AS committee_chamber
      FROM hearings h
      LEFT JOIN committees c ON c.id = h.committee_id
      ${where}
      ORDER BY h.held_on DESC NULLS LAST
    `, params);

    res.json({ data: rows, count: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getHearing(req, res) {
  try {
    const { rows } = await db.query(`
      SELECT
        h.id, h.title, h.congress, h.held_on, h.status,
        h.video_url, h.video_source, h.official_url,
        h.created_at, h.updated_at,
        c.id   AS committee_id,
        c.name AS committee_name,
        c.chamber AS committee_chamber,
        COALESCE(
          json_agg(json_build_object(
            'id',         t.id,
            'source',     t.source,
            'is_primary', t.is_primary,
            'status',     t.status,
            'created_at', t.created_at
          )) FILTER (WHERE t.id IS NOT NULL),
          '[]'
        ) AS transcripts
      FROM hearings h
      LEFT JOIN committees c ON c.id = h.committee_id
      LEFT JOIN transcripts t ON t.hearing_id = h.id
      WHERE h.id = $1
      GROUP BY h.id, c.id
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Hearing not found' });
    res.json({ data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getHearingTranscript(req, res) {
  try {
    const { rows: hearingRows } = await db.query(`
      SELECT h.*, c.name AS committee_name, c.chamber AS committee_chamber
      FROM hearings h
      LEFT JOIN committees c ON c.id = h.committee_id
      WHERE h.id = $1
    `, [req.params.id]);

    if (!hearingRows.length) return res.status(404).json({ error: 'Hearing not found' });

    const { rows: txRows } = await db.query(`
      SELECT * FROM transcripts
      WHERE hearing_id = $1
      ORDER BY is_primary DESC, created_at DESC
      LIMIT 1
    `, [req.params.id]);

    if (!txRows.length) {
      return res.json({ data: { hearing: hearingRows[0], transcript: null } });
    }

    const transcript = txRows[0];

    // speaker_ordinal is the derived "Speaker N" (appearance order of editable
    // speaker buckets) — the display fallback for unattributed speakers, kept
    // consistent with the review workbench even after structural edits.
    // Blank turns (admin-inserted slots awaiting text) are excluded.
    const { rows: turns } = await db.query(`
      SELECT
        st.id, st.seq, st.member_id, st.speaker_label_raw,
        f.speaker_ordinal,
        st.speaker_name, st.speaker_role,
        st.start_ms, st.end_ms, st.attribution_status,
        st.raw_text, st.clean_text, st.word_times, st.is_edited,
        m.full_name AS member_full_name, m.bioguide_id,
        m.party, m.state, m.chamber,
        COALESCE(
          (SELECT json_agg(json_build_object('id', t.id, 'slug', t.slug, 'name', t.name)
                           ORDER BY t.name)
             FROM turn_topics tt
             JOIN topics t ON t.id = tt.topic_id
            WHERE tt.turn_id = st.id),
          '[]'
        ) AS topics
      FROM speaker_turns st
      JOIN (SELECT speaker_key, dense_rank() OVER (ORDER BY min(seq))::int AS speaker_ordinal
              FROM speaker_turns WHERE transcript_id = $1
             GROUP BY speaker_key) f ON f.speaker_key = st.speaker_key
      LEFT JOIN members m ON m.id = st.member_id
      WHERE st.transcript_id = $1 AND st.raw_text <> ''
      ORDER BY st.seq
    `, [transcript.id]);

    // Navigable structure, if this hearing has been sectioned. Ranges only —
    // end_seq is derived from the next section's start, exactly as the admin
    // side derives it. Empty array when detection has never run, so the reader
    // view degrades to a plain transcript.
    const { rows: sections } = await db.query(`
      SELECT hs.id, hs.type, hs.label, hs.member_id,
             st.seq AS start_seq,
             lead(st.seq) OVER (ORDER BY st.seq) AS next_seq,
             m.full_name AS member_full_name
        FROM hearing_sections hs
        JOIN speaker_turns st ON st.id = hs.start_turn_id
        LEFT JOIN members m ON m.id = hs.member_id
       WHERE hs.transcript_id = $1
       ORDER BY st.seq
    `, [transcript.id]).catch(() => ({ rows: [] }));
    const lastSeq = turns.length ? turns[turns.length - 1].seq : 0;
    const withRanges = sections.map((s) => ({
      ...s,
      end_seq: s.next_seq != null ? s.next_seq - 1 : lastSeq,
    }));

    res.json({ data: { hearing: hearingRows[0], transcript: { ...transcript, turns, sections: withRanges } } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { listHearings, getHearing, getHearingTranscript };
