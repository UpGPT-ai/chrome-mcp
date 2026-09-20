/**
 * Random loading messages
 * Used by the TimelineStatusStep component to show playful waiting prompts
 */

const loadingTexts = [
  // Classic memes
  'This was supposed to be smooth and effortless',
  'Now it is a frantic scramble',
  'I know you are in a hurry, but hold on',
  'Doggy-paddling through an ocean of knowledge',
  'Let the bullet fly a little longer',
  'Hand-crafting your answer',
  'The little goblins are assembling',
  "Stop nagging, I'm already writing it (new folder)",
  'Thinking so hard I am breaking a sweat',
  'My CPU is about to catch fire',
  // Everyday life
  'Slow roast in progress, good things take time',
  'Flipping the knowledge pancake',
  'Pouring myself a drink, ready in a sec',
  'Putting inspiration in the oven',
  'Letting the answer steep a bit longer',
  'Maxing out the emotional support',
  'Knitting you a sweater of words',
  // Wild imagination
  'Neurons hitting the dance floor',
  'A night-owl is pondering',
  'Coloring in the answer',
  'Frantically flipping through the knowledge base',
  'The brain circus is starting',
  'Squishing 0s and 1s together',
  'Charging up a big move',
  'The magnifying glass fogged up, wiping it',
  'Trying to make sense of this absurd request',
  // Fantasy
  'Casting a spell, do not disturb',
  'Waking up my silicon friend',
  'Connecting to the wisdom of cyberspace',
  'Hold on, fellow traveler, I am calculating',
  'Crossing the knowledge black hole',
  'Reverse-engineering human intent',
  'The crystal ball is fuzzy, giving it a tap',
  // Work mode
  'Code runs faster than a reporter',
  'The host is online, please wait',
  'Rushing over at full speed',
  'Hauling knowledge at light speed',
  'The last piece of the puzzle',
  'The answer is almost a wrap',
  'Launch countdown',
  'Locking onto the target',
];

/**
 * Get a random loading message
 */
export function getRandomLoadingText(): string {
  return loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
}
