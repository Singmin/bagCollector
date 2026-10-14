interface CardBackground { src: string; lightText: boolean }

const background = (file: string, lightText = false): CardBackground => ({
  src: `/static/cardBackground/${file}.png`, lightText
});
const brandBackgrounds = [
  { aliases: ['瑞幸', 'luckin'], artwork: background('luckinCoffee', true) },
  { aliases: ['霸王茶姬', 'chagee'], artwork: background('chagee', true) },
  { aliases: ['奈雪', 'naixue'], artwork: background('naiXue') },
  { aliases: ['一点点', '1点点', 'alittle'], artwork: background('aLittle', true) }
];
const genericBackgrounds = [1, 2, 3, 4].map(number => background(`bagCollection${number}`));

/** Assign once per card so flips and late detail updates never reroll its artwork. */
export function createCardBackgroundResolver() {
  const assignments = new Map<string, CardBackground>();
  return (id: string, brand: string, name: string): CardBackground => {
    for (const value of [brand, name]) {
      const normalized = value.toLowerCase().replace(/\s+/g, '');
      const match = brandBackgrounds.find(entry => entry.aliases.some(alias => normalized.includes(alias)));
      if (match) return match.artwork;
    }
    let artwork = assignments.get(id);
    if (!artwork) {
      artwork = genericBackgrounds[Math.floor(Math.random() * genericBackgrounds.length)];
      assignments.set(id, artwork);
    }
    return artwork;
  };
}
