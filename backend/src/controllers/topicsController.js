const db = require('../utils/db');

async function listTopics(_req, res) {
  try {
    const { rows } = await db.query(`
      SELECT id, parent_id, name, slug
      FROM   topics
      ORDER  BY parent_id NULLS FIRST, name
    `);

    const byId = new Map();
    const roots = [];
    for (const t of rows) {
      const node = { id: t.id, slug: t.slug, name: t.name, children: [] };
      byId.set(t.id, node);
      if (!t.parent_id) roots.push(node);
    }
    for (const t of rows) {
      if (t.parent_id && byId.has(t.parent_id)) {
        byId.get(t.parent_id).children.push({
          id: t.id, slug: t.slug, name: t.name,
        });
      }
    }

    res.json({ data: roots, count: roots.length });
  } catch (err) {
    console.error('listTopics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { listTopics };
