from contextlib import closing
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from chord_engine import lyrics as L


class SongSheetTests(unittest.TestCase):
    def test_opensong_columns_sections_and_repeats(self):
        song = L.read_import(b'<song><title>Original</title><presentation>V1 C C</presentation>'
                             b'<lyrics>[V1]\n.C   G/B\n This line\n[C]\n.D\n Chorus words</lyrics></song>',
                             'original.xml', 'en')[0]
        lines = song['chart']
        self.assertEqual(lines[1]['text'], 'This line')
        self.assertEqual(lines[1]['chords'], [{'at': 0, 'label': 'C'}, {'at': 4, 'label': 'G/B'}])
        self.assertEqual([line['text'] for line in lines if line.get('section')], ['[V1]', '[C]', '[C]'])

    def test_openlyrics_inline_legacy_structured_and_br(self):
        xml = ('<song xmlns="http://openlyrics.info/namespace/2009/song">'
               '<properties><titles><title>Original</title></titles></properties>'
               '<lyrics><verse name="v1"><lines>Пр<chord name="Am"/>имер<br/>'
               '<chord root="D" structure="dom7" bass="F#">Yeni</chord> satır</lines>'
               '</verse></lyrics></song>')
        song = L.read_import(xml.encode(), 'original.xml', 'bg')[0]
        first, second = [row for row in song['chart'] if row['chords']]
        self.assertEqual((first['text'], first['chords']), ('Пример', [{'at': 2, 'label': 'Am'}]))
        self.assertEqual((second['text'], second['chords']), ('Yeni satır', [{'at': 0, 'label': 'D7/F#'}]))

    def test_chordpro_inline_positions_and_chorus(self):
        source = '{title: Original}\n{soc}\n[F#m7]Bir [D/F#]satır\n{eoc}\n{chorus: Final}'
        song = L.read_import(source.encode(), 'original.cho', 'tr')[0]
        self.assertEqual(song['title'], 'Original')
        self.assertEqual([row['text'] for row in song['chart'] if row.get('section')], ['[Chorus]', '[Final]'])
        self.assertEqual(song['chart'][1]['chords'], [{'at': 0, 'label': 'F#m7'}, {'at': 4, 'label': 'D/F#'}])
        self.assertEqual(song['chart'][1]['chords'], song['chart'][3]['chords'])

    def test_plain_is_not_a_chart_and_chart_is_authorized_body(self):
        data = b'<song><title>Original</title><lyrics>[V1]\n This line\n.Notes</lyrics></song>'
        self.assertNotIn('chart', L.read_import(data, 'original.xml', 'en')[0])
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            chart = root / 'original.cho'
            chart.write_text('{title: Original}\n[C]This line', encoding='utf8')
            db_path = root / 'lyrics.sqlite3'
            request = dict(action='import', song='test', metadata={'title': 'Original'}, path=str(chart))
            with self.assertRaises(ValueError):
                L.dispatch(db_path, request)
            result = L.dispatch(db_path, request | {'authorized': True})
            self.assertEqual(result['candidates'][0]['chart'][0]['chords'][0]['label'], 'C')
            with closing(L.connect(db_path)) as db:
                self.assertNotIn('"chart"', db.execute('SELECT metadata FROM candidates').fetchone()[0])


if __name__ == '__main__':
    unittest.main()

