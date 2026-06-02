require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const db = require('../../src/utils/db');

// Word-level timestamps for the first speaker turn (Chair Smith's opening statement).
// Format: { w: word, s: start_ms, e: end_ms }
const CHAIR_OPEN_WORD_TIMES = JSON.stringify([
  { w: 'The',             s: 0,     e: 300   },
  { w: 'committee',       s: 340,   e: 820   },
  { w: 'will',            s: 860,   e: 1060  },
  { w: 'come',            s: 1100,  e: 1350  },
  { w: 'to',              s: 1390,  e: 1510  },
  { w: 'order.',          s: 1550,  e: 2100  },
  { w: 'Today',           s: 2500,  e: 2820  },
  { w: 'we',              s: 2860,  e: 2980  },
  { w: 'examine',         s: 3020,  e: 3500  },
  { w: 'the',             s: 3540,  e: 3660  },
  { w: 'deployment',      s: 3700,  e: 4350  },
  { w: 'of',              s: 4390,  e: 4490  },
  { w: 'artificial',      s: 4530,  e: 5180  },
  { w: 'intelligence',    s: 5220,  e: 5940  },
  { w: 'systems',         s: 5980,  e: 6480  },
  { w: 'across',          s: 6520,  e: 6980  },
  { w: 'federal',         s: 7020,  e: 7480  },
  { w: 'agencies,',       s: 7520,  e: 8180  },
  { w: 'with',            s: 8400,  e: 8580  },
  { w: 'particular',      s: 8620,  e: 9180  },
  { w: 'attention',       s: 9220,  e: 9720  },
  { w: 'to',              s: 9760,  e: 9880  },
  { w: 'procurement',     s: 9920,  e: 10680 },
  { w: 'standards',       s: 10720, e: 11280 },
  { w: 'and',             s: 11320, e: 11480 },
  { w: 'civil-liberties', s: 11520, e: 12480 },
  { w: 'safeguards.',     s: 12520, e: 13200 },
]);

async function seed() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      TRUNCATE speaker_turns, transcripts, committee_memberships,
               hearings, committees, members CASCADE
    `);

    const { rows: committees } = await client.query(`
      INSERT INTO committees (name, chamber) VALUES
        ('Senate Judiciary Committee',     'senate'),
        ('House Appropriations Committee', 'house'),
        ('Senate Intelligence Committee',  'senate')
      RETURNING id, name
    `);

    const byName = name => committees.find(c => c.name === name).id;
    const senJudId = byName('Senate Judiciary Committee');
    const hseAppId = byName('House Appropriations Committee');
    const senIntId = byName('Senate Intelligence Committee');

    const { rows: members } = await client.query(`
      INSERT INTO members (bioguide_id, full_name, member_type, chamber, party, state, district) VALUES
        ('S000001', 'Jane Smith',      'senator',        'senate', 'D', 'CA', NULL),
        ('S000002', 'Robert Johnson',  'senator',        'senate', 'R', 'TX', NULL),
        ('S000003', 'Patricia Lee',    'senator',        'senate', 'D', 'WA', NULL),
        ('R000001', 'Maria Garcia',    'representative', 'house',  'D', 'NY', 14),
        ('R000002', 'David Chen',      'representative', 'house',  'R', 'FL', 7),
        ('R000003', 'Marcus Williams', 'representative', 'house',  'D', 'IL', 1)
      RETURNING id, full_name
    `);

    const byMember = name => members.find(m => m.full_name === name).id;
    const janeId    = byMember('Jane Smith');
    const robertId  = byMember('Robert Johnson');
    const patriciaId= byMember('Patricia Lee');
    const mariaId   = byMember('Maria Garcia');
    const davidId   = byMember('David Chen');
    const marcusId  = byMember('Marcus Williams');

    await client.query(`
      INSERT INTO committee_memberships (member_id, committee_id, role, congress) VALUES
        ($1,  $2,  'chair',          119),
        ($3,  $4,  'ranking_member', 119),
        ($5,  $6,  'member',         119),
        ($7,  $8,  'chair',          119),
        ($9,  $10, 'member',         119),
        ($11, $12, 'member',         119)
    `, [
      janeId,    senJudId,
      robertId,  senJudId,
      patriciaId,senIntId,
      mariaId,   hseAppId,
      davidId,   hseAppId,
      marcusId,  hseAppId,
    ]);

    const { rows: hearings } = await client.query(`
      INSERT INTO hearings (committee_id, title, congress, held_on, status) VALUES
        ($1, 'Oversight Hearing on Artificial Intelligence in Federal Agencies', 119, '2025-03-15', 'published'),
        ($2, 'FY2026 Discretionary Budget Review',                               119, '2025-04-22', 'published'),
        ($3, 'Threats to Critical Infrastructure: Cyber and Physical Security',  119, '2025-05-08', 'published'),
        ($1, 'Data Privacy and National Security Act — Markup Session',          119, '2025-06-10', 'scheduled')
      RETURNING id, title
    `, [senJudId, hseAppId, senIntId]);

    // ── Hearing 1: AI oversight (has word_times on turn 1) ───────────────────
    const h1Id = hearings[0].id;
    const { rows: tx1Rows } = await client.query(`
      INSERT INTO transcripts (hearing_id, source, is_primary, status)
      VALUES ($1, 'gpo_official', true, 'complete')
      RETURNING id
    `, [h1Id]);

    const tx1Id = tx1Rows[0].id;
    await client.query(`
      INSERT INTO speaker_turns
        (transcript_id, member_id, seq, speaker_name, speaker_role,
         start_ms, end_ms, raw_text, word_times)
      VALUES
        ($1, $2, 1, 'Chair Smith',            'chair',   0,     14800,
         'The committee will come to order. Today we examine the deployment of artificial intelligence systems across federal agencies, with particular attention to procurement standards and civil-liberties safeguards.',
         $4::jsonb),
        ($1, $3, 2, 'Ranking Member Johnson', 'member',  15000, 34500,
         'Thank you Madam Chair. I appreciate the committee convening on this topic. My primary concerns remain cost efficiency, accountability, and ensuring these systems do not introduce new attack surfaces for our adversaries.',
         NULL),
        ($1, $2, 3, 'Chair Smith',            'chair',   35000, 52000,
         'Those are exactly the questions our witnesses are best positioned to answer. I want to remind members that we will observe the five-minute rule strictly today given the number of witnesses.',
         NULL),
        ($1, NULL, 4, 'Dr. Amara Osei',       'witness', 52500, 89000,
         'Thank you Chair Smith and Ranking Member Johnson. Our review of fourteen agency AI deployments found that only three had completed formal risk assessments prior to production rollout. That gap represents a significant governance failure we believe Congress must address through statute rather than guidance alone.',
         NULL)
    `, [tx1Id, janeId, robertId, CHAIR_OPEN_WORD_TIMES]);

    // ── Hearing 2: Budget review ──────────────────────────────────────────────
    const h2Id = hearings[1].id;
    const { rows: tx2Rows } = await client.query(`
      INSERT INTO transcripts (hearing_id, source, is_primary, status)
      VALUES ($1, 'gpo_official', true, 'complete')
      RETURNING id
    `, [h2Id]);

    const tx2Id = tx2Rows[0].id;
    await client.query(`
      INSERT INTO speaker_turns
        (transcript_id, member_id, seq, speaker_name, speaker_role,
         start_ms, end_ms, raw_text, word_times)
      VALUES
        ($1, $2, 1, 'Chair Garcia',  'chair',  0,     12000,
         'The subcommittee will come to order. We are here today to review the administration''s FY2026 discretionary budget request.',
         NULL),
        ($1, $3, 2, 'Rep. Chen',     'member', 12500, 29000,
         'Thank you Madam Chair. I want to focus specifically on the proposed fifteen-percent reduction to the CISA budget, which I believe is shortsighted given the threat environment described in last month''s intelligence briefing.',
         NULL),
        ($1, $4, 3, 'Rep. Williams', 'member', 29500, 47000,
         'I share that concern. I would also draw the subcommittee''s attention to the infrastructure investments in the Great Lakes region that would be deferred under this proposal.',
         NULL)
    `, [tx2Id, mariaId, davidId, marcusId]);

    await client.query('COMMIT');

    console.log('Seed complete.');
    console.log(`  ${committees.length} committees`);
    console.log(`  ${members.length} members`);
    console.log(`  ${hearings.length} hearings`);
    console.log('  2 transcripts (hearing 1 has 27 word-level timestamps on turn 1)');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await db.end();
  }
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
