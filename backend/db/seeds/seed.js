require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });
const db = require('../../src/utils/db');

async function seed() {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Wipe in dependency order so FK constraints are satisfied
    await client.query(`
      TRUNCATE speaker_turns, transcripts, committee_memberships,
               hearings, committees, members CASCADE
    `);

    const { rows: committees } = await client.query(`
      INSERT INTO committees (name, chamber) VALUES
        ('Senate Judiciary Committee',          'senate'),
        ('House Appropriations Committee',      'house'),
        ('Senate Intelligence Committee',       'senate')
      RETURNING id, name
    `);

    const byName = name => committees.find(c => c.name === name).id;
    const senJudId  = byName('Senate Judiciary Committee');
    const hseAppId  = byName('House Appropriations Committee');
    const senIntId  = byName('Senate Intelligence Committee');

    const { rows: members } = await client.query(`
      INSERT INTO members (bioguide_id, full_name, member_type, chamber, party, state, district) VALUES
        ('S000001', 'Jane Smith',       'senator',        'senate', 'D', 'CA', NULL),
        ('S000002', 'Robert Johnson',   'senator',        'senate', 'R', 'TX', NULL),
        ('S000003', 'Patricia Lee',     'senator',        'senate', 'D', 'WA', NULL),
        ('R000001', 'Maria Garcia',     'representative', 'house',  'D', 'NY', 14),
        ('R000002', 'David Chen',       'representative', 'house',  'R', 'FL', 7),
        ('R000003', 'Marcus Williams',  'representative', 'house',  'D', 'IL', 1)
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
        ($1, $2, 'chair',          119),
        ($3, $4, 'ranking_member', 119),
        ($5, $6, 'member',         119),
        ($7, $8, 'chair',          119),
        ($9, $10,'member',         119),
        ($11,$12,'member',         119)
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

    // Transcript + speaker turns for the first hearing
    const h1Id = hearings[0].id;
    const { rows: txRows } = await client.query(`
      INSERT INTO transcripts (hearing_id, source, is_primary, status)
      VALUES ($1, 'gpo_official', true, 'complete')
      RETURNING id
    `, [h1Id]);

    const txId = txRows[0].id;
    await client.query(`
      INSERT INTO speaker_turns
        (transcript_id, member_id, seq, speaker_name, speaker_role, start_ms, end_ms, raw_text)
      VALUES
        ($1, $2, 1, 'Chair Smith',            'chair',   0,     14800, 'The committee will come to order. Today we examine the deployment of artificial intelligence systems across federal agencies, with particular attention to procurement standards and civil-liberties safeguards.'),
        ($1, $3, 2, 'Ranking Member Johnson', 'member',  15000, 34500, 'Thank you Madam Chair. I appreciate the committee convening on this topic. My primary concerns remain cost efficiency, accountability, and ensuring these systems do not introduce new attack surfaces for our adversaries.'),
        ($1, $2, 3, 'Chair Smith',            'chair',   35000, 52000, 'Those are exactly the questions our witnesses are best positioned to answer. I want to remind members that we will observe the five-minute rule strictly today given the number of witnesses.'),
        ($1, NULL,4, 'Dr. Amara Osei',        'witness', 52500, 89000, 'Thank you Chair Smith and Ranking Member Johnson. Our review of fourteen agency AI deployments found that only three had completed formal risk assessments prior to production rollout. That gap represents a significant governance failure we believe Congress must address through statute rather than guidance alone.')
    `, [txId, janeId, robertId]);

    // Transcript + speaker turns for the second hearing
    const h2Id = hearings[1].id;
    const { rows: tx2Rows } = await client.query(`
      INSERT INTO transcripts (hearing_id, source, is_primary, status)
      VALUES ($1, 'gpo_official', true, 'complete')
      RETURNING id
    `, [h2Id]);

    const tx2Id = tx2Rows[0].id;
    await client.query(`
      INSERT INTO speaker_turns
        (transcript_id, member_id, seq, speaker_name, speaker_role, start_ms, end_ms, raw_text)
      VALUES
        ($1, $2, 1, 'Chair Garcia',  'chair',  0,     12000, 'The subcommittee will come to order. We are here today to review the administrations FY2026 discretionary budget request.'),
        ($1, $3, 2, 'Rep. Chen',     'member', 12500, 29000, 'Thank you Madam Chair. I want to focus specifically on the proposed fifteen-percent reduction to the CISA budget, which I believe is shortsighted given the threat environment described in last months intelligence briefing.'),
        ($1, $4, 3, 'Rep. Williams', 'member', 29500, 47000, 'I share that concern. I would also draw the subcommittees attention to the infrastructure investments in the Great Lakes region that would be deferred under this proposal.')
    `, [tx2Id, mariaId, davidId, marcusId]);

    await client.query('COMMIT');

    console.log('Seed complete.');
    console.log(`  ${committees.length} committees`);
    console.log(`  ${members.length} members`);
    console.log(`  ${hearings.length} hearings`);
    console.log('  2 transcripts with speaker turns');
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
