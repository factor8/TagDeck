import { useState } from 'react';
import './App.css';
import { Search } from 'lucide-react';
import { LibraryImporter } from './components/LibraryImporter';
import { TrackList } from './components/TrackList';
import { Player } from './components/Player';
import { TagEditor } from './components/TagEditor';
import { TagDeck } from './components/TagDeck';
import { Track } from './types';

function App() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [selectedTrack, setSelectedTrack] = useState<Track | null>(null);
  const [currentTags, setCurrentTags] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  const handleRefresh = () => {
    setRefreshTrigger(prev => prev + 1);
  };
  
  const handleTrackSelect = (track: Track) => {
    setSelectedTrack(track);
    // Parse tags to highlight them in the deck
    if (track.comment_raw) {
        const splitIndex = track.comment_raw.indexOf(' && ');
        if (splitIndex !== -1) {
            const tagBlock = track.comment_raw.substring(splitIndex + 4);
            setCurrentTags(tagBlock.split(';').map(t => t.trim()).filter(t => t.length > 0));
        } else {
            setCurrentTags([]);
        }
    } else {
        setCurrentTags([]);
    }
  };

  const handleDeckTagClick = (tag: string) => {
      // This will be passed down to TagEditor to actually modify the track
      // Or we can modify it here if we hoist the "Save" logic?
      // For now, let's signal the TagEditor... but TagEditor has its own state.
      // Better: We need a way to tell TagEditor "Add this tag".
      // Let's pass a prop to TagEditor `externalTagToAdd`.
      // OR, simpler: We hoist the tags state to App? 
      // For this phase, let's just log it or try to implement the plumbing.
      const event = new CustomEvent('add-tag-deck', { detail: tag });
      window.dispatchEvent(event);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      
      {/* Header */}
      <header style={{ 
        height: '60px', 
        padding: '0 20px', 
        background: 'var(--bg-secondary)', 
        borderBottom: '1px solid var(--border-color)',
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'center',
        flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{ width: '24px', height: '24px', background: 'var(--accent-color)', borderRadius: '4px' }}></div>
          <h1 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)', letterSpacing: '-0.5px' }}>TagDeck</h1>
        </div>
        
        {/* Search Bar */}
        <div style={{ flex: 1, maxWidth: '500px', margin: '0 20px', position: 'relative' }}>
            <div style={{ 
                position: 'absolute', 
                left: '10px', 
                top: '50%', 
                transform: 'translateY(-50%)',
                color: 'var(--text-secondary)',
                pointerEvents: 'none'
            }}>
                <Search size={16} />
            </div>
            <input 
                type="text" 
                placeholder="Search library..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                    width: '100%',
                    padding: '8px 10px 8px 36px',
                    borderRadius: '6px',
                    border: '1px solid var(--border-color)',
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                    outline: 'none'
                }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent-color)'}
                onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
            />
        </div>

        <div>
          <LibraryImporter onImportComplete={handleRefresh} />
        </div>
      </header>

      {/* Main Content Area */}
      <div style={{ 
        flex: 1, 
        overflow: 'hidden', 
        position: 'relative',
        display: 'flex'
      }}>
        {/* Track List Container */}
        <div style={{ 
          flex: 1, 
          overflow: 'hidden', 
          display: 'flex',
          flexDirection: 'column'
        }}>
          <TrackList 
            refreshTrigger={refreshTrigger} 
            onSelect={handleTrackSelect}
            selectedTrackId={selectedTrack ? selectedTrack.id : null}
            searchTerm={searchTerm}
          />
        </div>

        {/* Right Sidebar: Tag Editor + Tag Deck */}
        <div style={{ 
            width: '320px', 
            flexShrink: 0, 
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            borderLeft: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)'
        }}>
           {/* Editor Panel (Fixed at top of sidebar) */}
           {selectedTrack ? (
               <TagEditor 
                    track={selectedTrack} 
                    onUpdate={handleRefresh} 
               />
           ) : (
               <div style={{ padding: '20px', color: 'var(--text-secondary)', textAlign: 'center', fontSize: '13px' }}>
                   Select a track to edit tags
               </div>
           )}

           {/* Tag Deck (Takes remaining space) */}
           <div style={{ flex: 1, overflow: 'hidden' }}>
               <TagDeck 
                    onTagClick={handleDeckTagClick} 
                    currentTrackTags={currentTags}
                    refreshTrigger={refreshTrigger}
                />
           </div>
        </div>
      </div>

      {/* Player Footer */}
      <Player track={selectedTrack} />
    </div>
  );
}

export default App;
