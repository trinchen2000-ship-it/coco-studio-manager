const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize Database
async function initDB() {
    try {
        // Freelancers
        await pool.query(`
            CREATE TABLE IF NOT EXISTS freelancers (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) NOT NULL,
                adresse TEXT,
                farbe VARCHAR(7) DEFAULT '#10b981',
                archived BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Kautionen (inkl. Gutscheine und PayPal)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS kautionen (
                id SERIAL PRIMARY KEY,
                freelancer_id INTEGER REFERENCES freelancers(id),
                datum DATE NOT NULL,
                bezeichnung VARCHAR(100),
                betrag DECIMAL(10,2) NOT NULL,
                typ VARCHAR(20) DEFAULT 'Kaution',
                ausgezahlt BOOLEAN DEFAULT false,
                termin_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Termine
        await pool.query(`
            CREATE TABLE IF NOT EXISTS termine (
                id SERIAL PRIMARY KEY,
                freelancer_id INTEGER REFERENCES freelancers(id),
                datum DATE NOT NULL,
                gesamtbetrag DECIMAL(10,2) NOT NULL,
                studio_anteil DECIMAL(10,2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Buchungen (Kassenbuch)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS buchungen (
                id SERIAL PRIMARY KEY,
                datum DATE NOT NULL,
                typ VARCHAR(10) NOT NULL CHECK (typ IN ('einnahme', 'ausgabe')),
                betrag DECIMAL(10,2) NOT NULL,
                bemerkung TEXT,
                quelle VARCHAR(50) DEFAULT 'manuell',
                termin_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Einstellungen
        await pool.query(`
            CREATE TABLE IF NOT EXISTS einstellungen (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT
            )
        `);

        console.log('✅ Datenbank initialisiert');
    } catch (err) {
        console.error('Datenbankfehler:', err);
    }
}

// ============ FREELANCER API ============

app.get('/api/freelancers', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM freelancers ORDER BY archived, name');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/freelancers', async (req, res) => {
    try {
        const { name, adresse, farbe } = req.body;
        const result = await pool.query(
            'INSERT INTO freelancers (name, adresse, farbe) VALUES ($1, $2, $3) RETURNING *',
            [name, adresse || '', farbe || '#10b981']
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/freelancers/:id', async (req, res) => {
    try {
        const { name, adresse, farbe, archived } = req.body;
        const result = await pool.query(
            'UPDATE freelancers SET name=$1, adresse=$2, farbe=$3, archived=$4 WHERE id=$5 RETURNING *',
            [name, adresse, farbe, archived || false, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/freelancers/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM freelancers WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ KAUTIONEN API ============

app.get('/api/kautionen', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT k.*, f.name as freelancer_name 
            FROM kautionen k 
            LEFT JOIN freelancers f ON k.freelancer_id = f.id 
            ORDER BY k.datum DESC, k.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/kautionen/freelancer/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM kautionen WHERE freelancer_id = $1 ORDER BY datum DESC',
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/kautionen', async (req, res) => {
    try {
        const { freelancer_id, datum, bezeichnung, betrag, typ } = req.body;
        const result = await pool.query(
            'INSERT INTO kautionen (freelancer_id, datum, bezeichnung, betrag, typ) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [freelancer_id, datum, bezeichnung, betrag, typ || 'Kaution']
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/kautionen/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM kautionen WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ TERMINE API ============

app.get('/api/termine', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*, f.name as freelancer_name,
                   (SELECT json_agg(k.*) FROM kautionen k WHERE k.termin_id = t.id) as verrechnungen
            FROM termine t
            LEFT JOIN freelancers f ON t.freelancer_id = f.id
            ORDER BY t.datum DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/termine/freelancer/:id', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*,
                   (SELECT json_agg(k.*) FROM kautionen k WHERE k.termin_id = t.id) as verrechnungen
            FROM termine t
            WHERE t.freelancer_id = $1
            ORDER BY t.datum DESC
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/termine', async (req, res) => {
    try {
        const { freelancer_id, datum, gesamtbetrag, kaution_ids, gutscheine, paypal_kautionen } = req.body;
        const studio_anteil = gesamtbetrag * 0.3;

        // Freelancer Name holen
        const flResult = await pool.query('SELECT name FROM freelancers WHERE id=$1', [freelancer_id]);
        const freelancerName = flResult.rows[0]?.name || 'Unbekannt';

        // Termin erstellen
        const terminResult = await pool.query(
            'INSERT INTO termine (freelancer_id, datum, gesamtbetrag, studio_anteil) VALUES ($1, $2, $3, $4) RETURNING *',
            [freelancer_id, datum, gesamtbetrag, studio_anteil]
        );
        const termin = terminResult.rows[0];

        // Bestehende Kautionen verrechnen
        if (kaution_ids && kaution_ids.length > 0) {
            for (const kId of kaution_ids) {
                // Kaution als ausgezahlt markieren
                const kResult = await pool.query(
                    'UPDATE kautionen SET ausgezahlt=true, termin_id=$1 WHERE id=$2 RETURNING *',
                    [termin.id, kId]
                );
                const kaution = kResult.rows[0];
                
                // Ausgabe im Kassenbuch erstellen
                if (kaution) {
                    await pool.query(
                        'INSERT INTO buchungen (datum, typ, betrag, bemerkung, quelle, termin_id) VALUES ($1, $2, $3, $4, $5, $6)',
                        [datum, 'ausgabe', kaution.betrag, `Kaution an ${freelancerName} ${kaution.bezeichnung}`, 'termin', termin.id]
                    );
                }
            }
        }

        // Gutscheine erstellen und verrechnen
        if (gutscheine && gutscheine.length > 0) {
            for (const g of gutscheine) {
                // Gutschein als Kaution speichern
                await pool.query(
                    'INSERT INTO kautionen (freelancer_id, datum, bezeichnung, betrag, typ, ausgezahlt, termin_id) VALUES ($1, $2, $3, $4, $5, true, $6)',
                    [freelancer_id, datum, g.bezeichnung, g.betrag, 'Gutschein', termin.id]
                );
                
                // Ausgabe im Kassenbuch erstellen
                await pool.query(
                    'INSERT INTO buchungen (datum, typ, betrag, bemerkung, quelle, termin_id) VALUES ($1, $2, $3, $4, $5, $6)',
                    [datum, 'ausgabe', g.betrag, `Gutschein an ${freelancerName} ${g.bezeichnung}`, 'termin', termin.id]
                );
            }
        }

        // PayPal-Kautionen erstellen und verrechnen
        if (paypal_kautionen && paypal_kautionen.length > 0) {
            for (const p of paypal_kautionen) {
                // PayPal als Kaution speichern
                await pool.query(
                    'INSERT INTO kautionen (freelancer_id, datum, bezeichnung, betrag, typ, ausgezahlt, termin_id) VALUES ($1, $2, $3, $4, $5, true, $6)',
                    [freelancer_id, datum, p.bezeichnung, p.betrag, 'PayPal', termin.id]
                );
                
                // Ausgabe im Kassenbuch erstellen
                await pool.query(
                    'INSERT INTO buchungen (datum, typ, betrag, bemerkung, quelle, termin_id) VALUES ($1, $2, $3, $4, $5, $6)',
                    [datum, 'ausgabe', p.betrag, `PayPal an ${freelancerName} ${p.bezeichnung}`, 'termin', termin.id]
                );
            }
        }

        console.log(`✅ Termin erstellt: ${freelancerName}, ${gesamtbetrag}€`);
        res.json(termin);
    } catch (err) {
        console.error('Termin-Fehler:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/termine/:id', async (req, res) => {
    try {
        const terminId = req.params.id;
        
        // Kautionen zurücksetzen (nur echte Kautionen, nicht Gutscheine/PayPal)
        await pool.query(
            "UPDATE kautionen SET ausgezahlt=false, termin_id=NULL WHERE termin_id=$1 AND typ='Kaution'",
            [terminId]
        );
        
        // Gutscheine und PayPal löschen (die wurden beim Termin erstellt)
        await pool.query(
            "DELETE FROM kautionen WHERE termin_id=$1 AND typ IN ('Gutschein', 'PayPal')",
            [terminId]
        );
        
        // Buchungen löschen
        await pool.query('DELETE FROM buchungen WHERE termin_id=$1', [terminId]);
        
        // Termin löschen
        await pool.query('DELETE FROM termine WHERE id=$1', [terminId]);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ BUCHUNGEN (KASSENBUCH) API ============

app.get('/api/buchungen', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM buchungen ORDER BY datum DESC, created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/buchungen', async (req, res) => {
    try {
        const { datum, typ, betrag, bemerkung } = req.body;
        const result = await pool.query(
            'INSERT INTO buchungen (datum, typ, betrag, bemerkung, quelle) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [datum, typ, betrag, bemerkung || '', 'manuell']
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/buchungen/:id', async (req, res) => {
    try {
        const { datum, typ, betrag, bemerkung } = req.body;
        const result = await pool.query(
            'UPDATE buchungen SET datum=$1, typ=$2, betrag=$3, bemerkung=$4 WHERE id=$5 RETURNING *',
            [datum, typ, betrag, bemerkung, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/buchungen/:id', async (req, res) => {
    try {
        // Nur manuelle Buchungen löschen erlauben
        const check = await pool.query("SELECT quelle FROM buchungen WHERE id=$1", [req.params.id]);
        if (check.rows[0]?.quelle !== 'manuell') {
            return res.status(400).json({ error: 'Automatische Buchungen können nur über den Termin gelöscht werden' });
        }
        await pool.query('DELETE FROM buchungen WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ EINSTELLUNGEN API ============

app.get('/api/einstellungen/:key', async (req, res) => {
    try {
        const result = await pool.query('SELECT value FROM einstellungen WHERE key=$1', [req.params.key]);
        res.json({ value: result.rows[0]?.value || null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/einstellungen/:key', async (req, res) => {
    try {
        const { value } = req.body;
        await pool.query(
            'INSERT INTO einstellungen (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=$2',
            [req.params.key, value]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ AUSWERTUNG API ============

app.get('/api/auswertung/:monat', async (req, res) => {
    try {
        const monat = req.params.monat; // Format: 2025-11
        const startDate = monat + '-01';
        const endDate = monat + '-31';

        // Termine pro Freelancer
        const termineResult = await pool.query(`
            SELECT f.id, f.name, f.farbe,
                   COUNT(t.id) as anzahl_termine,
                   COALESCE(SUM(t.gesamtbetrag), 0) as umsatz,
                   COALESCE(SUM(t.studio_anteil), 0) as studio_anteil
            FROM freelancers f
            LEFT JOIN termine t ON f.id = t.freelancer_id AND t.datum BETWEEN $1 AND $2
            WHERE f.archived = false
            GROUP BY f.id, f.name, f.farbe
            ORDER BY f.name
        `, [startDate, endDate]);

        // Offene Kautionen pro Freelancer
        const kautionenResult = await pool.query(`
            SELECT freelancer_id, COUNT(*) as anzahl, COALESCE(SUM(betrag), 0) as summe
            FROM kautionen
            WHERE ausgezahlt = false AND typ = 'Kaution'
            GROUP BY freelancer_id
        `);

        const kautionenMap = {};
        kautionenResult.rows.forEach(k => {
            kautionenMap[k.freelancer_id] = { anzahl: parseInt(k.anzahl), summe: parseFloat(k.summe) };
        });

        const auswertung = termineResult.rows.map(f => ({
            ...f,
            anzahl_termine: parseInt(f.anzahl_termine),
            umsatz: parseFloat(f.umsatz),
            studio_anteil: parseFloat(f.studio_anteil),
            kautionen_anzahl: kautionenMap[f.id]?.anzahl || 0,
            kautionen_summe: kautionenMap[f.id]?.summe || 0
        }));

        res.json(auswertung);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server läuft auf Port ${PORT}`);
    });
});
