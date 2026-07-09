# How AI Tag Suggestions Work

TagDeck can listen to a song and suggest tags for it, drawn from the tags you already use. When you turn the feature on, it downloads a small "listening" model to your Mac (a one-time download — nothing is ever uploaded, and the app works exactly the same without it). That model listens to a few short slices of each track and turns what it hears — the energy, the mood, the instruments, the rhythm — into a kind of musical fingerprint. Every song you own gets its own fingerprint, and songs that *sound* alike end up with similar fingerprints, even if their names and artists are completely different.

Once your library is fingerprinted, suggesting tags is mostly a matter of comparison. For a tag you've already used a fair amount — say you've marked a couple dozen tracks "Sinister" — TagDeck looks at a new song's fingerprint and asks, "does this sound like the other songs you called Sinister?" If it's a close match, Sinister floats up as a suggestion. In effect, the feature learns *your* taste from the tagging you've already done, rather than relying on some outside idea of what "Sinister" is supposed to mean. This is why the suggestions get noticeably better for the tags you use most.

For tags you've only used once or twice, there aren't enough examples to compare against yet, so TagDeck falls back to a more general approach: the model also understands short text descriptions, so it can compare a song's fingerprint against the plain meaning of a phrase like "a music track with a mellow mood." This works reasonably for concrete, describable qualities — genres, instruments, obvious moods — but it's fuzzier for the personal, hard-to-put-into-words tags that make your library yours. The more you tag, the more those tags graduate from this general guessing into the sharper, learned-from-you comparison above.

Everything the feature suggests is just a suggestion — it shows up as a faint, dashed chip in the tag editor, and nothing is written to your files until you click to accept it. You can dismiss anything that misses, and a sensitivity setting lets you decide whether you want only confident picks or a wider, looser net. Think of it less as an authority telling you what a song is, and more as a fast-learning assistant that watches how you tag and tries to save you the repetitive clicks.

## Ways It Could Get Better

There are two separate things worth improving, and it helps to keep them apart. The first is getting *sharper on the tags you already use a lot* — the ones with plenty of examples to learn from. The second is getting *more useful on the tags you've barely used*, where there isn't enough of your own history to lean on yet. Most of the ideas below aim at one or the other, and the honest picture is that the first is largely a tuning problem we can keep chipping at, while the second is mostly limited by how much you've tagged and how good the model's "ears" are.

To get sharper on your well-used tags, the natural idea is to study your own tagging even more carefully — instead of asking "does this sound close to the other songs you gave that tag?", build a little profile of what actually separates, say, your "Sinister" songs from everything else. We tried a simple version of this and, on a real library, it didn't reliably beat the "close to your examples" approach the feature already uses — that approach turns out to be a strong baseline once a tag has a good dozen examples. So the more promising path for well-used tags is really the same as the one below: better ears.

To get more useful on rarely-used tags, there are two routes. The gentle one — asking the question better — is already in: when the feature falls back to matching a song against the plain meaning of a phrase, it now tries several wordings of that phrase and combines them, which gives a fairer, steadier read on tags it has little history for, and it costs nothing to run. The bigger route is to give the feature better ears: swap the current listening model for a larger one, or one trained specifically on music rather than sounds in general. That would likely help across the board — both the sparse tags and the well-used ones — but it means a meaningfully larger download, so it's the kind of upgrade worth offering as a choice rather than forcing on everyone.

Finally, the simplest and most reliable lever is in your hands: keep tagging. Because the feature learns from your own labels, every track you tag makes that tag's future suggestions a little sharper, and tags gradually "graduate" from rough guessing into the confident, learned-from-you picks. None of the improvements above replace that — they just help the assistant make the most of the tagging you've already done.

## The Mechanics, Precisely (for reference)

The prose above is the friendly version. This section pins down exactly what
happens, because "the more you tag, the better it gets" is true but easy to
misread.

**There is no training step, and nothing gets "analyzed" a second time.** The
listening model (CLAP, run locally — no LLM, no cloud API, no fine-tuning) does
exactly one thing during analysis: it computes a fixed audio fingerprint for each
track and a fixed text fingerprint for each tag name. Those are stored once and
never change based on how you tag. See `src-tauri/src/analysis/clap.rs` and
`analyze_tracks` in `commands.rs`.

**Your tags are used live, at suggestion time — not baked into the model.** Every
time the suggestion UI opens, it re-reads which tracks currently carry each tag
(parsed fresh from the comment field, `commands.rs` `get_tag_suggestions`) and
scores each tag one of two ways, never blended (`scoring.rs`):

- **Zero-shot** — matches the track's audio fingerprint against the *text* of the
  tag name ("a Morning electronic music track"). Generic; the code itself notes
  it is "near-random for subjective tags."
- **k-NN (personalized)** — matches the track against the *songs you already gave
  that tag*, scoring by closeness to your own examples. This is the strong one.

**The switch between them is a hard cutoff at 8 examples, per tag.** A tag scored
below 8 tagged songs uses generic zero-shot; at 8 or more it flips to personalized
k-NN (`ScoreParams { knn_trust: 8, knn_top_k: 5 }` in `scoring.rs`, tuned on a
332-track library). Consequences:

- The count that matters is **per tag, not per library.** 500 tagged songs spread
  thin across many rarely-used tags helps almost nothing. The payoff is pushing an
  individual tag you care about past ~8 real examples.
- Beyond 8 there are still modest gains (the k-NN takes the 5 nearest of a denser,
  better-covered example set), but they diminish.
- It's **immediate** — no re-analysis. Tag an 8th song and that tag is personalized
  on the very next suggestion request.

So the honest guidance isn't "tag everything." It's: get each tag you care about to
roughly 8+ genuine examples. A handful of well-populated tags beats a huge, sparsely
tagged library.

## Growing Your Vocabulary (Optional)

Normally the feature only ever suggests tags you already use. There's an opt-in
setting (AI Tags in Settings) that lets it grow your vocabulary outward from the
shape of your tag cloud. If you already tag by time of day — Morning, Evening,
Prime Time — it notices the pattern and can propose the gap: Afternoon, say, when
a track sounds like it. You scan your tags, approve the ideas you like, and from
then on approved new tags show up as their own distinct ghost chips (with a
green dashed outline and a "new" marker) on tracks that fit. Accepting one both
creates the tag in the right group and applies it. It's off by default and uses
a stricter confidence bar than ordinary suggestions, because inventing a new tag
is a bigger step than reusing one you already have. The ideas come from a small
built-in map of common musical dimensions; nothing about your library leaves your
Mac.
