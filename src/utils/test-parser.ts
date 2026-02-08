
import { parseSearchQuery } from './searchParser.ts';

const queries = [
    'house party',
    '"deep house"',
    'artist:Prince',
    'bpm:120-130',
    'bpm:>125',
    'techno -minimal',
    'tag:warm',
    'label:"Defected"',
];

queries.forEach(q => {
    console.log(`Query: ${q}`);
    console.log(JSON.stringify(parseSearchQuery(q), null, 2));
    console.log('---');
});
