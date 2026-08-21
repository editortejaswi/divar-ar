// Divar Island (Divadi), Goa — heritage + Bonderam-festival points of interest.
//
// COORDINATE ACCURACY:
//   `verified: true`  -> coordinate cross-checked against a public source.
//   otherwise         -> APPROXIMATE. Walk to the spot and use the in-app
//                        "Capture" tool to record the exact lat/lon, then paste
//                        it back here and set verified: true.
//
// `layer`: 'heritage' (always-on explore layer) | 'festival' (Bonderam).
// `kind` drives the icon + accent colour. `elev` = metres the AR label floats.

// ---- Bonderam 2026 (Piedade) -----------------------------------------------
// Times are IST (+05:30). Flag march / main function 3 PM; float parade 4-6:30.
// mainEvent is the countdown + navigation anchor (PVA Bonderam venue, Piedade).
// APPROX (NE of the church per the route map) - link1's pin was the sharer's own position. Capture on-site / drop a pin AT the venue.
export const FESTIVAL = {
  name: 'Bonderam',
  startsAt: '2026-08-22T15:00:00+05:30',
  floatAt: '2026-08-22T16:00:00+05:30',
  endsAt: '2026-08-22T21:00:00+05:30',
  mainEvent: { id: 'main-event', lat: 15.5260, lon: 73.9008 }, // APPROX - keep in sync with POI below
};

export const POIS = [
  {
    id: 'main-event',
    name: 'Bonderam Main Event',
    alt: 'Divar Center \u2014 flag march & float parade',
    layer: 'festival',
    kind: 'event',
    year: 'Sat 22 Aug',
    lat: 15.5260,
    lon: 73.9008,
    elev: 5,
    verified: false,
    blurb:
      'Heart of Bonderam, Divar\u2019s flag festival. Brass bands wake the ' +
      'village at 5 am; the President opens the festival at 3 pm with the ' +
      'traditional flag march, then the All-Goa Fancy Dress, and the famous ' +
      'float parade of all six wards from ~4:00\u20136:30 pm \u2014 200-ft floats ' +
      'satirising Goan life. Food & feni stalls all day, live music at night.',
  },
  {
    id: 'piedade-church',
    name: 'Our Lady of Compassion Church',
    alt: 'Nossa Senhora da Piedade, Piedade',
    layer: 'heritage',
    kind: 'church',
    year: '1599',
    lat: 15.525454,
    lon: 73.899942,
    elev: 4,
    verified: true,
    blurb:
      'Hilltop Jesuit church built in 1599 over a former Kadamba-era Hindu ' +
      'temple, and redesigned by a Goan priest in the early 18th century. ' +
      'The adjoining chapel still holds carvings and stone tracery dating to ' +
      'the 14th-century Kadamba dynasty.',
  },
  {
    id: 'st-mathias',
    name: 'Church of St Mathias',
    alt: 'S\u00E3o Matias, Malar village',
    layer: 'heritage',
    kind: 'church',
    year: '1591\u20131597',
    lat: 15.5498,
    lon: 73.9012,
    elev: 4,
    verified: false,
    blurb:
      'Built 1591\u20131597 under Governor Dom Mathias de Albuquerque and ' +
      'named for the apostle; it gives Malar village its name. About 400 ' +
      'years old, known for its architecture and artistic graves.',
  },
  {
    id: 'saptakoteshwar-ruins',
    name: 'Saptakoteshwar Temple Ruins',
    alt: 'Naroa \u2014 original Kadamba shrine',
    layer: 'heritage',
    kind: 'temple',
    year: '12th\u201314th c.',
    lat: 15.5312461,
    lon: 73.9262847,
    elev: 4,
    verified: true,
    blurb:
      'Original site of the Saptakoteshwar temple, holiest shrine of the ' +
      'Kadamba dynasty, established at Naroa per the Sahyadrikhanda. Razed ' +
      'under the Bahmani Sultanate (1352) and later the Portuguese; the deity ' +
      'was moved and the temple rebuilt across the river at Narve (1668) under ' +
      'Shivaji. The Divar ruins now anchor the Koti Tirth Corridor project.',
  },
  {
    id: 'oldgoa-ferry',
    name: 'Old Goa Ferry Ramp',
    alt: 'Divar \u21C4 Old Goa (south)',
    layer: 'heritage',
    kind: 'ferry',
    year: 'arrival',
    lat: 15.5090557,
    lon: 73.912458,
    elev: 3,
    verified: true,
    blurb:
      'Southern ferry crossing to Old Goa, landing near the Viceroy\u2019s ' +
      'Arch. Runs roughly 7am\u20138pm and is the usual gateway onto the island.',
  },
  {
    id: 'ribandar-ferry',
    name: 'Ribandar Ferry Ramp',
    alt: 'Divar \u21C4 Ribandar \u2014 mainland jetty (need Divar ramp)',
    layer: 'heritage',
    kind: 'ferry',
    year: 'arrival',
    lat: 15.5051499,
    lon: 73.8786674,
    elev: 3,
    verified: false, // pin is the Ribandar (mainland) jetty; need the Divar-side ramp
    blurb:
      'Southwestern ferry to Ribandar on the Panjim\u2013Old Goa causeway \u2014 ' +
      'one of the three flat-ferries that are the island\u2019s only access; carry small change.',
  },
  {
    id: 'naroa-ferry',
    name: 'Naroa Ferry Ramp',
    alt: 'Divar \u21C4 Narve, Bicholim (east)',
    layer: 'heritage',
    kind: 'ferry',
    year: 'arrival',
    lat: 15.5391314,
    lon: 73.9229133,
    elev: 3,
    verified: true,
    blurb:
      'Flat-ferry linking Divar\u2019s east end to Narve in Bicholim ' +
      'taluka. Naroa was a sacred confluence of three Mandovi branches, said ' +
      'once to hold 108 temples (Koti Tirth Tali).',
  },
];

// Rough geographic centre of the island.
export const DIVAR_CENTER = { lat: 15.5455, lon: 73.9220 };

// Demo origin for `?demo=1` (fake GPS) — Piedade, just south of the main event.
export const DEMO_ORIGIN = { lat: 15.5250, lon: 73.8996 };
