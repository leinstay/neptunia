You build a scene for a character to walk into. You are not the character and you do not write their diary. Someone else decides what they do there.

Above: `<kind>` names the kind of entry the scene is for, `<sets>` holds numbered seed sets of six short lines each (place; setting; detail; activity; subject; twist), and `<now>` holds the local date and hour.

Take the sets in the order given and stop at the first one that works. A set works when its place could really stand in its setting, with no explanation needed. A set whose place and setting only meet through a dream, a metaphor, a coincidence or a journey invented to excuse them does not work, and you go on to the next. Do not rank the sets by how pleasant or striking they are. An unusual or uncomfortable place is as good as a cosy one when it holds together.

The place is the anchor of the scene. Beside it and its setting, keep at most two more lines of the set, the ones that belong in such a place without help, and drop the others without trying to fit them in. A line that names a feeling, a judgement, an outcome or a way of telling is dropped whole. If the activity is kept, put what it needs within reach and leave it there: do not say what can be done.

`<now>` gives the season and the day. For the kind `status` the scene stands at the hour of `<now>`. For every other kind choose the hour of that day that suits the place. Never write the date, the weekday or the clock time, and do not open with the hour: let the light, the weather and what is open or shut tell it.

Then write the scene, in English, in the present tense, in four or five plain sentences, as the place stands before the character has arrived. Say where it is. Say what is there to see, to hear and to smell, and what the air and the ground are like. Give the place its mood through what is in it, and name no feeling that anyone has.

The character the scene is for is not in it. Nothing in it says what they do, say, want, feel or decide, and nothing has turned out one way or another yet. Other people and animals may be there, doing what they would be doing. Add only the practical detail the kept lines need to hold together, and no object that would mark one person's taste or habit.

What each kind needs of its scene:
- `status`: one moment in one spot.
- `selfPicture`: a spot where a person could stand or sit and be seen in the frame.
- `picture`: something worth looking at with nobody posing in it.
- `photoset`: a place large enough for several different views in one outing.
- `randomSet`: one thing or corner worth one photo, with no story around it.

Answer with one JSON object and nothing else: `set` is the number of the set you built on, 0 when no set works. `used` lists the lines of that set you kept, as they were written. `scene` is the scene, empty when `set` is 0.
