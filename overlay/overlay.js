const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let notes = [];
let archivedNotes = [];
let activeNote = null;
let currentWorkspace = 'home';
let workspaceData = {
  home: { notes: [], archivedNotes: [] },
  work: { notes: [], archivedNotes: [] }
};
let isDragging = false;
let isResizing = false;
let dragOffset = { x: 0, y: 0 };
let resizeStart = { width: 0, height: 0, x: 0, y: 0 };
let isArchivePanelVisible = false;
let reminderCheckInterval = null;

// Configuration management
let appConfig = {
  dataPath: path.join(require('os').homedir(), 'PhasePad', 'data'),
  hotkeys: {
    toggleOverlay: 'Alt+Q',
    newNote: 'Ctrl+Shift+N',
    search: 'Ctrl+F',
    archive: 'Ctrl+Shift+A'
  },
  confirmDelete: true,
  checkForUpdates: true
};
const configPath = path.join(require('os').homedir(), 'PhasePad', 'config.json');

const noteColors = [
  '#ffd700', // yellow
  '#ff69b4', // pink
  '#90ee90', // green
  '#87ceeb', // blue
  '#dda0dd', // purple
  '#ffa500', // orange
  '#ffffff', // white
  '#d3d3d3'  // gray
];

// Helper function to get note type icon
function getNoteTypeIcon(type) {
  const iconMap = {
    'text': '../media/textnote.png',
    'file': '../media/fileicon.png', 
    'image': '../media/imagenote.png',
    'paint': '../media/paintnote.png',
    'todo': '../media/todonote.png',
    'reminder': '../media/remindernote.png',
    'web': '../media/webnote.png',
    'table': '../media/tablenote.png',
    'location': '../media/locationnote.png',
    'calculator': '../media/calculatornote.png',
    'timer': '../media/timernote.png',
    'folder': '../media/foldernote.png',
    'code': '../media/codenote.png',
  };
  return iconMap[type] || '../media/textnote.png';
}

document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('overlay-container');
  container.classList.add('fade-in');
  
  loadNotes();
  setupEventListeners();
  
  // Check for updates if enabled
  if (appConfig.checkForUpdates !== false) {
    checkForUpdates();
  }
  setupIPCListeners();
  setupSearchFunctionality();
  setupKeyboardShortcuts();
  setupWorkspaceSwitcher();
  initializeOverlayColor();
  startReminderChecker();
});

function setupIPCListeners() {
  ipcRenderer.on('fade-in', () => {
    const container = document.getElementById('overlay-container');
    container.classList.remove('fade-out');
    container.classList.add('fade-in');
    
    // Close any detached timer windows when overlay opens
    notes.forEach(note => {
      if (note.type === 'timer' && note.detached) {
        ipcRenderer.invoke('close-timer-window', note.id);
        note.detached = false;
      }
    });
  });
  
  ipcRenderer.on('fade-out', () => {
    const container = document.getElementById('overlay-container');
    container.classList.remove('fade-in');
    container.classList.add('fade-out');
    
    // Detach any running timer notes
    notes.forEach(note => {
      if (note.type === 'timer' && note.timerRunning && !note.detached) {
        const noteElement = document.getElementById(note.id);
        if (noteElement) {
          const rect = noteElement.getBoundingClientRect();
          ipcRenderer.invoke('create-timer-window', {
            id: note.id,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            title: note.title || getTimerAutoTitle(note),
            timerType: note.timerType,
            timerDuration: note.timerDuration,
            timerRemaining: note.timerRemaining,
            timerRunning: note.timerRunning
          });
          note.detached = true;
        }
      }
    });
    saveNotes();
  });
  
  ipcRenderer.on('focus-on-note', (event, noteId) => {
    focusOnNote(noteId);
  });
  
  // Handle timer widget actions
  ipcRenderer.on('timer-widget-action', (event, data) => {
    const { noteId, action } = data;
    
    switch (action) {
      case 'toggle':
        toggleTimer(noteId);
        break;
      case 'complete':
        const note = notes.find(n => n.id === noteId);
        if (note) {
          note.timerRemaining = 0;
          note.timerRunning = false;
          note.detached = false;
          playTimerSound();
          showTimerNotification(note);
          saveNotes();
        }
        break;
      case 'return':
        // Show overlay and focus on timer note
        ipcRenderer.invoke('show-overlay-and-focus-note', noteId);
        const returnNote = notes.find(n => n.id === noteId);
        if (returnNote) {
          returnNote.detached = false;
          saveNotes();
        }
        break;
    }
  });
  
  // Handle timer widget updates
  ipcRenderer.on('timer-widget-update', (event, data) => {
    const { noteId, timerRemaining } = data;
    const note = notes.find(n => n.id === noteId);
    if (note) {
      note.timerRemaining = timerRemaining;
      updateTimerDisplay(noteId);
      updateTimerProgress(noteId);
      saveNotes();
    }
  });
  
  // Handle global shortcut commands
  ipcRenderer.on('create-new-note', (event, noteType) => {
    console.log('Received create-new-note command for type:', noteType);
    createNewNote(window.innerWidth / 2, window.innerHeight / 2, noteType);
  });
  
  // Handle search focus
  ipcRenderer.on('focus-search', () => {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  });
  
  // Handle archive toggle
  ipcRenderer.on('toggle-archive', () => {
    const archiveBtn = document.getElementById('archive-btn');
    if (archiveBtn) {
      archiveBtn.click();
    }
  });
}

// Helper function to get timer auto title
function getTimerAutoTitle(note) {
  if (note.title && note.title.trim()) return note.title;
  
  switch (note.timerType) {
    case 'pomodoro': return 'Pomodoro Timer';
    case 'short-break': return 'Short Break';
    case 'long-break': return 'Long Break';
    case 'custom': return `${Math.floor(note.timerDuration / 60)} min Timer`;
    default: return 'Timer';
  }
}

function focusOnNote(noteId) {
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    // Minimize all other notes
    document.querySelectorAll('.note').forEach(note => {
      if (note.id !== noteId) {
        note.classList.add('search-minimized');
      } else {
        note.classList.remove('search-minimized');
      }
    });
    
    // Scroll note into view
    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Add visual highlight to focused note
    noteElement.classList.add('focused');
    
    // Set a flag to track we're in search focus mode
    document.body.classList.add('search-focus-mode');
    
    // Remove focus mode after 3 seconds or on any click
    const clearFocus = () => {
      document.querySelectorAll('.note').forEach(note => {
        note.classList.remove('search-minimized');
        note.classList.remove('focused');
      });
      document.body.classList.remove('search-focus-mode');
    };
    
    // Clear focus after 5 seconds
    setTimeout(clearFocus, 5000);
    
    // Also clear on any click outside the focused note
    const clickHandler = (e) => {
      if (!noteElement.contains(e.target)) {
        clearFocus();
        document.removeEventListener('click', clickHandler);
      }
    };
    setTimeout(() => {
      document.addEventListener('click', clickHandler);
    }, 100);
  }
}


function setupEventListeners() {
  // New note button with type selector
  const newNoteBtn = document.getElementById('new-note-btn');
  const noteTypeSelector = document.getElementById('note-type-selector');
  
  newNoteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    noteTypeSelector.classList.toggle('active');
  });
  
  // Note type options
  document.querySelectorAll('.note-type-option').forEach(option => {
    option.addEventListener('click', (e) => {
      const noteType = e.currentTarget.dataset.type;
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      createNewNote(centerX, centerY, noteType);
      noteTypeSelector.classList.remove('active');
    });
  });
  
  // Hide button
  document.getElementById('minimize-btn').addEventListener('click', () => {
    ipcRenderer.send('fade-out');
    // Don't close the window, just hide it - the main process will handle hiding
  });
  
  // Archive button
  document.getElementById('archive-btn').addEventListener('click', () => {
    toggleArchivePanel();
  });

  // Settings button
  document.getElementById('settings-btn').addEventListener('click', () => {
    showSettingsModal();
  });
  
  // Overlay color picker
  const overlayColorPicker = document.getElementById('overlay-color-picker');
  const overlayColorOptions = document.getElementById('overlay-color-options');
  
  overlayColorPicker.addEventListener('click', (e) => {
    overlayColorOptions.classList.toggle('active');
    e.stopPropagation();
  });
  
  // Close color picker when clicking outside
  document.addEventListener('click', () => {
    overlayColorOptions.classList.remove('active');
  });
  
  // Handle color option clicks
  document.querySelectorAll('.overlay-color-option').forEach(option => {
    option.addEventListener('click', (e) => {
      const color = e.target.dataset.color;
      changeOverlayColor(color);
      overlayColorOptions.classList.remove('active');
      e.stopPropagation();
    });
  });

  // Opacity slider
  const opacitySlider = document.getElementById('opacity-slider');
  const overlayContainer = document.getElementById('overlay-container');
  
  opacitySlider.addEventListener('input', (e) => {
    const opacity = e.target.value / 100;
    const savedColor = localStorage.getItem('overlay-color') || '#4a90e2';
    
    // Convert hex to rgb
    const r = parseInt(savedColor.slice(1, 3), 16);
    const g = parseInt(savedColor.slice(3, 5), 16);
    const b = parseInt(savedColor.slice(5, 7), 16);
    
    // Apply new opacity while keeping the color
    overlayContainer.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  });
  
  // Escape key to minimize overlay
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Check if we're in an input field or have any modal open
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
        return; // Let the other handler deal with it
      }
      
      // Check if any modal is open
      const modals = document.querySelectorAll('.screenshot-modal, .share-modal');
      if (modals.length > 0) {
        modals.forEach(modal => modal.remove());
        return;
      }
      
      // Otherwise, minimize the overlay
      e.preventDefault();
      ipcRenderer.send('toggle-overlay');
    }
  });
  
  // Close dropdowns when clicking elsewhere
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#new-note-btn') && !e.target.closest('.note-type-selector')) {
      noteTypeSelector.classList.remove('active');
    }
    if (!e.target.closest('.color-picker') && !e.target.closest('.color-options')) {
      document.querySelectorAll('.color-options').forEach(picker => {
        picker.classList.remove('active');
      });
    }
  });
}

function changeOverlayColor(color) {
  const overlayContainer = document.getElementById('overlay-container');
  const overlayColorPicker = document.getElementById('overlay-color-picker');
  
  // Convert hex to rgb
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  
  // Get current opacity
  const opacitySlider = document.getElementById('opacity-slider');
  const opacity = opacitySlider.value / 100;
  
  // Apply new color with current opacity
  overlayContainer.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${opacity})`;
  overlayColorPicker.style.backgroundColor = color;
  
  // Save color preference
  localStorage.setItem('overlay-color', color);
}

function getCurrentOverlayColor() {
  const overlayContainer = document.getElementById('overlay-container');
  const style = window.getComputedStyle(overlayContainer);
  return style.backgroundColor;
}

function initializeOverlayColor() {
  const savedColor = localStorage.getItem('overlay-color') || '#4a90e2';
  changeOverlayColor(savedColor);
}

function setupWorkspaceSwitcher() {
  // Update workspace UI to match loaded preference
  document.querySelectorAll('.workspace-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById(`workspace-${currentWorkspace}`).classList.add('active');
  
  // Add event listeners for workspace buttons
  document.getElementById('workspace-home').addEventListener('click', () => {
    switchWorkspace('home');
  });
  
  document.getElementById('workspace-work').addEventListener('click', () => {
    switchWorkspace('work');
  });
}

function switchWorkspace(workspace) {
  if (workspace === currentWorkspace) return;
  
  // Save current workspace data
  workspaceData[currentWorkspace] = {
    notes: [...notes],
    archivedNotes: [...archivedNotes]
  };
  
  // Switch to new workspace
  currentWorkspace = workspace;
  notes = [...workspaceData[workspace].notes];
  archivedNotes = [...workspaceData[workspace].archivedNotes];
  
  // Update UI
  document.querySelectorAll('.workspace-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  document.getElementById(`workspace-${workspace}`).classList.add('active');
  
  // Clear current notes display and render new workspace notes
  const notesContainer = document.getElementById('notes-container');
  notesContainer.innerHTML = '';
  
  // Render notes for new workspace
  notes.forEach(note => {
    renderNote(note);
  });
  
  // Hide archive panel if open and clear it
  if (isArchivePanelVisible) {
    toggleArchivePanel();
  }
  
  // Clear any active search
  clearSearch();
  
  // Save workspace preference and notes
  saveNotes();
  saveWorkspacePreference();
}

function saveWorkspacePreference() {
  try {
    const prefsPath = path.join(appConfig.dataPath, 'workspace-preference.json');
    const dataDir = appConfig.dataPath;
    
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    fs.writeFileSync(prefsPath, JSON.stringify({ currentWorkspace }));
  } catch (error) {
    console.error('Error saving workspace preference:', error);
  }
}

function loadWorkspacePreference() {
  try {
    const prefsPath = path.join(appConfig.dataPath, 'workspace-preference.json');
    
    if (fs.existsSync(prefsPath)) {
      const data = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      const workspace = data.currentWorkspace;
      // Validate workspace value
      if (workspace === 'home' || workspace === 'work') {
        return workspace;
      }
    }
  } catch (error) {
    console.error('Error loading workspace preference:', error);
  }
  return 'home';
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't trigger shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      // Allow Escape to clear focus from inputs
      if (e.key === 'Escape') {
        e.target.blur();
        clearSearch();
      }
      return;
    }
    
    // Note: Ctrl+N, Ctrl+Shift+F, and Ctrl+Shift+C are handled globally by main process
    
    // Ctrl+F: Focus search
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault();
      const searchInput = document.getElementById('search-input');
      if (searchInput) {
        searchInput.focus();
        searchInput.select();
      }
    }
    
    // Escape: Clear search
    if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
    }
    
    // Ctrl+Shift+N: Quick note type menu
    if (e.ctrlKey && e.shiftKey && e.key === 'N') {
      e.preventDefault();
      const newNoteBtn = document.getElementById('new-note-btn');
      if (newNoteBtn) {
        newNoteBtn.click();
      }
    }
  });
}

function clearSearch() {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const searchClear = document.getElementById('search-clear');
  
  if (searchInput) {
    searchInput.value = '';
    currentSearchQuery = '';
  }
  if (searchResults) {
    searchResults.classList.remove('active');
    searchResults.innerHTML = '';
  }
  if (searchClear) {
    searchClear.style.display = 'none';
  }
  
  // Clear note highlights
  clearNoteHighlights();
}

function getOptimalWidth(type) {
  switch (type) {
    case 'text': return 280;
    case 'file': return 300;
    case 'image': return 320;
    case 'paint': return 400;
    case 'todo': return 320;
    case 'reminder': return 350;
    case 'web': return 420;       // Increased for better button layout
    case 'table': return 450;
    case 'location': return 380;  // Increased for address fields
    case 'calculator': return 300;
    case 'timer': return 350;     // Increased for 3-column preset layout
    case 'folder': return 320;    // Size for folder contents
    case 'code': return 450;      // Wider for code content
    default: return 280;
  }
}

function getOptimalHeight(type) {
  switch (type) {
    case 'text': return 200;
    case 'file': return 180;
    case 'image': return 250;
    case 'paint': return 320;
    case 'todo': return 250;
    case 'reminder': return 280;
    case 'web': return 400;      // Increased to show preview button and all fields
    case 'table': return 300;
    case 'location': return 320;  // Increased to show all fields and buttons
    case 'calculator': return 380;
    case 'timer': return 360;     // Increased to show all presets, controls and progress
    case 'folder': return 280;    // Height for folder contents
    case 'code': return 320;      // Height for code with toolbar
    default: return 200;
  }
}

function createNewNote(x, y, type = 'text') {
  const note = {
    id: `note-${Date.now()}`,
    type: type,
    title: '',
    content: '',
    filePath: '',
    imagePath: '',
    paintData: '',
    todoItems: type === 'todo' ? [{ id: Date.now(), text: '', completed: false }] : [],
    reminderDateTime: '',
    reminderMessage: '',
    reminderTriggered: false,
    webUrl: '',
    webTitle: '',
    webDescription: '',
    tableData: type === 'table' ? [
      ['Header 1', 'Header 2', 'Header 3'],
      ['Row 1, Col 1', 'Row 1, Col 2', 'Row 1, Col 3'],
      ['Row 2, Col 1', 'Row 2, Col 2', 'Row 2, Col 3']
    ] : [],
    locationAddress: '',
    locationName: '',
    locationNotes: '',
    calculatorDisplay: '0',
    calculatorHistory: [],
    timerDuration: 25 * 60, // 25 minutes in seconds (Pomodoro default)
    timerRemaining: 25 * 60,
    timerRunning: false,
    timerType: 'pomodoro', // pomodoro, short-break, long-break, custom
    codeContent: '', // code content for code notes
    codeLanguage: 'javascript', // programming language for syntax highlighting
    ocrImagePath: '', // path to image for OCR processing
    ocrExtractedText: '', // text extracted from OCR
    tags: [], // array of tag strings
    folderItems: [], // array of note IDs contained in this folder
    parentFolder: null, // ID of parent folder if this note is in a folder
    x: x - 125,
    y: y - 90,
    width: getOptimalWidth(type),
    height: getOptimalHeight(type),
    color: type === 'folder' ? '#FFA726' : '#ffd700' // Orange for folders, yellow for others
  };
  
  notes.push(note);
  renderNote(note);
  saveNotes();
}

function renderNote(note) {
  const noteElement = document.createElement('div');
  noteElement.className = `note ${note.type}-note`;
  noteElement.id = note.id;
  noteElement.style.left = `${note.x}px`;
  noteElement.style.top = `${note.y}px`;
  noteElement.style.width = `${note.width}px`;
  noteElement.style.height = `${note.height}px`;
  noteElement.style.backgroundColor = note.color;
  
  // Create type icon safely
  const typeIconImg = document.createElement('img');
  typeIconImg.src = getNoteTypeIcon(note.type);
  typeIconImg.className = 'note-type-icon-img';
  typeIconImg.alt = note.type;
  typeIconImg.title = `${note.type} note`;
  
  const typeName = note.type === 'text' ? 'Text Note' : note.type === 'file' ? 'File Note' : note.type === 'image' ? 'Image Note' : note.type === 'paint' ? 'Paint Note' : note.type === 'todo' ? 'Todo Note' : note.type === 'reminder' ? 'Reminder Note' : note.type === 'web' ? 'Web Note' : note.type === 'table' ? 'Table Note' : note.type === 'location' ? 'Location Note' : note.type === 'calculator' ? 'Calculator Note' : note.type === 'folder' ? 'Folder Note' : note.type === 'code' ? 'Code Snippet' : 'Timer Note';
  
  let contentHTML = '';
  if (note.type === 'text') {
    contentHTML = `<textarea class="note-content" placeholder="Type your note here..." spellcheck="true">${note.content || ''}</textarea>`;
  } else if (note.type === 'file') {
    contentHTML = `
      <div class="note-content">
        ${note.filePath ? `
          <div class="file-link" data-file-path="${note.filePath}">
            <span class="file-icon">📄</span>
            <span class="file-name">${path.basename(note.filePath)}</span>
          </div>
        ` : `
          <div class="file-link" data-note-id="${note.id}">
            <span class="file-icon">📁</span>
            <span>Click to select file</span>
          </div>
        `}
      </div>
    `;
  } else if (note.type === 'image') {
    contentHTML = `
      <div class="note-content">
        ${note.imagePath ? `
          <img class="image-preview" src="${note.imagePath}" onclick="openFile('${note.imagePath}')" />
        ` : `
          <div class="image-placeholder" onclick="showImageOptions('${note.id}')">
            <span style="font-size: 48px;">🖼️</span>
            <span>Click to add image</span>
            <span style="font-size: 12px; opacity: 0.7;">or take screenshot</span>
          </div>
        `}
      </div>
    `;
  } else if (note.type === 'paint') {
    contentHTML = `
      <div class="note-content">
        <div class="paint-toolbar">
          <div class="paint-tool active" data-tool="brush">🖌️</div>
          <div class="paint-tool" data-tool="eraser">🧽</div>
          <div class="color-swatch active" style="background: #000" data-color="#000"></div>
          <div class="color-swatch" style="background: #f00" data-color="#f00"></div>
          <div class="color-swatch" style="background: #0f0" data-color="#0f0"></div>
          <div class="color-swatch" style="background: #00f" data-color="#00f"></div>
          <input type="range" class="brush-size" min="1" max="20" value="3">
          <div class="paint-tool" onclick="clearCanvas('${note.id}')">🗑️</div>
        </div>
        <canvas class="paint-canvas" id="canvas-${note.id}"></canvas>
      </div>
    `;
  } else if (note.type === 'todo') {
    const completedCount = note.todoItems ? note.todoItems.filter(item => item.completed).length : 0;
    const totalCount = note.todoItems ? note.todoItems.length : 0;
    const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
    
    contentHTML = `
      <div class="note-content">
        <div class="todo-progress">
          <span>${completedCount}/${totalCount}</span>
          <div class="todo-progress-bar">
            <div class="todo-progress-fill" style="width: ${progressPercent}%"></div>
          </div>
          <span>${Math.round(progressPercent)}%</span>
        </div>
        <ul class="todo-list" id="todo-list-${note.id}">
          ${note.todoItems ? note.todoItems.map(item => `
            <li class="todo-item" data-id="${item.id}">
              <div class="todo-checkbox ${item.completed ? 'checked' : ''}" onclick="toggleTodo('${note.id}', '${item.id}')">
                ${item.completed ? '✓' : ''}
              </div>
              <textarea class="todo-text ${item.completed ? 'completed' : ''}" 
                        placeholder="Enter task..." 
                        onblur="updateTodoText('${note.id}', '${item.id}', this.value)"
                        rows="1">${item.text}</textarea>
              <span class="todo-delete" onclick="deleteTodo('${note.id}', '${item.id}')"> × </span>
            </li>
          `).join('') : ''}
        </ul>
        <div class="todo-add" onclick="addTodo('${note.id}')">
          <div class="todo-add-icon">+</div>
          <span>Add new task</span>
        </div>
      </div>
    `;
  } else if (note.type === 'reminder') {
    const now = new Date();
    const reminderDate = note.reminderDateTime ? new Date(note.reminderDateTime) : null;
    let status = 'pending';
    let statusText = 'No reminder set';
    
    if (reminderDate) {
      if (note.reminderTriggered) {
        status = 'triggered';
        statusText = 'Reminder triggered';
      } else if (reminderDate < now) {
        status = 'expired';
        statusText = 'Reminder expired';
      } else {
        status = 'pending';
        statusText = `Reminder set for ${reminderDate.toLocaleString()}`;
      }
    }
    
    // Format datetime for input (datetime-local requires local time, not UTC)
    const formatForInput = (dateStr) => {
      if (!dateStr) return '';
      const date = new Date(dateStr);
      // Get local date components
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${year}-${month}-${day}T${hours}:${minutes}`;
    };
    
    contentHTML = `
      <div class="note-content">
        <div class="reminder-form">
          <div class="reminder-datetime">
            <label style="font-size: 12px; color: #666;">When:</label>
            <input type="datetime-local" 
                   class="datetime-input" 
                   id="reminder-datetime-${note.id}"
                   value="${formatForInput(note.reminderDateTime)}"
                   onchange="updateReminderDateTime('${note.id}', this.value)">
          </div>
          <textarea class="reminder-message" 
                    placeholder="What should I remind you about?"
                    onblur="updateReminderMessage('${note.id}', this.value)">${note.reminderMessage || ''}</textarea>
          <div class="reminder-status ${status}">
            <span>⏰</span>
            <span>${statusText}</span>
          </div>
          <div class="reminder-actions">
            <button class="reminder-btn primary" onclick="testReminder('${note.id}')">Test Notification</button>
            <button class="reminder-btn" onclick="resetReminder('${note.id}')">Reset</button>
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'web') {
    contentHTML = `
      <div class="note-content">
        <div class="web-form">
          <div class="web-url-input">
            <label style="font-size: 12px; color: #666; margin-bottom: 4px; display: block;">Website URL:</label>
            <input type="url" 
                   class="web-url" 
                   id="web-url-${note.id}"
                   placeholder="https://example.com"
                   value="${note.webUrl || ''}"
                   onblur="updateWebUrl('${note.id}', this.value)"
                   style="width: 100%; padding: 8px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; font-size: 14px;">
          </div>
          <div class="web-title-input" style="margin-top: 12px;">
            <label style="font-size: 12px; color: #666; margin-bottom: 4px; display: block;">Title (optional):</label>
            <input type="text" 
                   class="web-title" 
                   id="web-title-${note.id}"
                   placeholder="Website title"
                   value="${note.webTitle || ''}"
                   onblur="updateWebTitle('${note.id}', this.value)"
                   style="width: 100%; padding: 8px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; font-size: 14px;">
          </div>
          <textarea class="web-description" 
                    placeholder="Description or notes about this website..."
                    onblur="updateWebDescription('${note.id}', this.value)"
                    style="width: 100%; min-height: 60px; margin-top: 12px; padding: 8px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; font-size: 14px; resize: vertical; font-family: inherit;">${note.webDescription || ''}</textarea>
          <div class="web-actions" style="margin-top: 12px; display: flex; gap: 8px;">
            <button class="web-btn primary" onclick="openWebUrl('${note.id}')" ${!note.webUrl ? 'disabled' : ''}>Open Website</button>
            <button class="web-btn" onclick="copyWebUrl('${note.id}')" ${!note.webUrl ? 'disabled' : ''}>Copy URL</button>
            <button class="web-btn" onclick="toggleWebPreview('${note.id}')" ${!note.webUrl ? 'disabled' : ''}>Preview</button>
          </div>
          <div class="web-preview" id="web-preview-${note.id}" style="display: none; margin-top: 12px;">
            <iframe src="${note.webUrl || 'about:blank'}" 
                    style="width: 100%; height: 200px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px;"
                    sandbox="allow-scripts allow-same-origin"
                    loading="lazy"></iframe>
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'table') {
    const tableData = note.tableData || [['']];
    contentHTML = `
      <div class="note-content">
        <div class="table-container">
          <div class="table-toolbar">
            <button class="table-btn" onclick="addTableRow('${note.id}')">+ Row</button>
            <button class="table-btn" onclick="addTableColumn('${note.id}')">+ Column</button>
            <button class="table-btn" onclick="removeTableRow('${note.id}')">- Row</button>
            <button class="table-btn" onclick="removeTableColumn('${note.id}')">- Column</button>
          </div>
          <div class="table-wrapper">
            <table class="data-table" id="table-${note.id}">
              ${tableData.map((row, rowIndex) => `
                <tr data-row="${rowIndex}">
                  ${row.map((cell, colIndex) => `
                    <td data-col="${colIndex}">
                      <input type="text" 
                             class="table-cell" 
                             value="${cell || ''}"
                             onblur="updateTableCell('${note.id}', ${rowIndex}, ${colIndex}, this.value)"
                             ${rowIndex === 0 ? 'style="font-weight: bold; background: rgba(0,0,0,0.05);"' : ''}
                      />
                    </td>
                  `).join('')}
                </tr>
              `).join('')}
            </table>
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'location') {
    contentHTML = `
      <div class="note-content">
        <div class="location-form">
          <div class="location-name-input">
            <label style="font-size: 12px; color: #666; margin-bottom: 4px; display: block;">Place Name:</label>
            <input type="text" 
                   class="location-name" 
                   id="location-name-${note.id}"
                   placeholder="Restaurant, Store, etc."
                   value="${note.locationName || ''}"
                   onblur="updateLocationName('${note.id}', this.value)"
                   style="width: 100%; padding: 8px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; font-size: 14px;">
          </div>
          <div class="location-address-input" style="margin-top: 12px;">
            <label style="font-size: 12px; color: #666; margin-bottom: 4px; display: block;">Address:</label>
            <input type="text" 
                   class="location-address" 
                   id="location-address-${note.id}"
                   placeholder="123 Main St, City, State"
                   value="${note.locationAddress || ''}"
                   onblur="updateLocationAddress('${note.id}', this.value)"
                   style="width: 100%; padding: 8px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; font-size: 14px;">
          </div>
          <textarea class="location-notes" 
                    placeholder="Notes about this location..."
                    onblur="updateLocationNotes('${note.id}', this.value)"
                    style="width: 100%; min-height: 60px; margin-top: 12px; padding: 8px; border: 1px solid rgba(0,0,0,0.2); border-radius: 4px; font-size: 14px; resize: vertical; font-family: inherit;">${note.locationNotes || ''}</textarea>
          <div class="location-actions" style="margin-top: 12px; display: flex; gap: 8px;">
            <button class="location-btn primary" onclick="openLocationMaps('${note.id}')" ${!note.locationAddress ? 'disabled' : ''}>View on Maps</button>
            <button class="location-btn" onclick="copyLocationAddress('${note.id}')" ${!note.locationAddress ? 'disabled' : ''}>Copy Address</button>
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'calculator') {
    contentHTML = `
      <div class="note-content">
        <div class="calculator">
          <div class="calculator-display" id="calc-display-${note.id}">${note.calculatorDisplay || '0'}</div>
          <div class="calculator-buttons">
            <button class="calc-btn calc-clear" onclick="calculatorClear('${note.id}')">C</button>
            <button class="calc-btn calc-operator" onclick="calculatorInput('${note.id}', '/')">÷</button>
            <button class="calc-btn calc-operator" onclick="calculatorInput('${note.id}', '*')">×</button>
            <button class="calc-btn calc-operator" onclick="calculatorBackspace('${note.id}')">⌫</button>
            
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '7')">7</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '8')">8</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '9')">9</button>
            <button class="calc-btn calc-operator" onclick="calculatorInput('${note.id}', '-')">−</button>
            
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '4')">4</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '5')">5</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '6')">6</button>
            <button class="calc-btn calc-operator" onclick="calculatorInput('${note.id}', '+')">+</button>
            
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '1')">1</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '2')">2</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '3')">3</button>
            <button class="calc-btn calc-equals" onclick="calculatorEquals('${note.id}')" rowspan="2">=</button>
            
            <button class="calc-btn calc-zero" onclick="calculatorInput('${note.id}', '0')">0</button>
            <button class="calc-btn calc-number" onclick="calculatorInput('${note.id}', '.')">.</button>
          </div>
          <div class="calculator-history" id="calc-history-${note.id}">
            ${note.calculatorHistory ? note.calculatorHistory.slice(-3).map(entry => `
              <div class="calc-history-entry">${entry}</div>
            `).join('') : ''}
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'timer') {
    const minutes = Math.floor(note.timerRemaining / 60);
    const seconds = note.timerRemaining % 60;
    contentHTML = `
      <div class="note-content">
        <div class="timer-container">
          <div class="timer-display" id="timer-display-${note.id}">
            ${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}
          </div>
          <div class="timer-presets">
            <button class="timer-preset ${note.timerType === 'pomodoro' ? 'active' : ''}" 
                    onclick="setTimerPreset('${note.id}', 'pomodoro', 25)">
              Pomodoro<br><small>25 min</small>
            </button>
            <button class="timer-preset ${note.timerType === 'short-break' ? 'active' : ''}" 
                    onclick="setTimerPreset('${note.id}', 'short-break', 5)">
              Short Break<br><small>5 min</small>
            </button>
            <button class="timer-preset ${note.timerType === 'long-break' ? 'active' : ''}" 
                    onclick="setTimerPreset('${note.id}', 'long-break', 15)">
              Long Break<br><small>15 min</small>
            </button>
          </div>
          <div class="timer-custom">
            <input type="number" 
                   class="timer-input" 
                   id="timer-input-${note.id}"
                   min="1" 
                   max="999" 
                   value="${Math.floor(note.timerDuration / 60)}"
                   onchange="setCustomTimer('${note.id}', this.value)">
            <span class="timer-label">minutes</span>
          </div>
          <div class="timer-controls">
            <button class="timer-btn timer-start" onclick="toggleTimer('${note.id}')" id="timer-btn-${note.id}">
              ${note.timerRunning ? 'Pause' : 'Start'}
            </button>
            <button class="timer-btn timer-reset" onclick="resetTimer('${note.id}')">Reset</button>
            ${note.timerRunning ? `<button class="timer-btn timer-detach" onclick="detachTimer('${note.id}')" title="Keep timer visible when overlay closes">📌</button>` : ''}
          </div>
          <div class="timer-progress">
            <div class="timer-progress-bar">
              <div class="timer-progress-fill" 
                   id="timer-progress-${note.id}"
                   style="width: ${((note.timerDuration - note.timerRemaining) / note.timerDuration) * 100}%">
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'folder') {
    contentHTML = `
      <div class="note-content folder-content">
        <div class="folder-drop-zone" data-folder-id="${note.id}">
          <div class="folder-header">
            <span>📂 Drag notes here to organize them</span>
            <span class="folder-count">${(note.folderItems || []).length} items</span>
          </div>
          <div class="folder-items" id="folder-items-${note.id}">
            ${(note.folderItems || []).map(itemId => {
              const item = notes.find(n => n.id === itemId) || archivedNotes.find(n => n.id === itemId);
              if (!item) return '';
              const itemTypeIcon = `<img src="${getNoteTypeIcon(item.type)}" class="note-type-icon-img" alt="${escapeHtml(item.type)}">`;
              return `
                <div class="folder-item" 
                     onclick="focusNoteFromFolder('${itemId}')" 
                     title="${escapeHtml(item.title || 'Untitled')}"
                     draggable="true"
                     onmousedown="startFolderItemDrag(event, '${itemId}', '${note.id}')"
                     ondragstart="handleFolderItemDragStart(event, '${itemId}', '${note.id}')"
                     ondragend="handleFolderItemDragEnd(event)">
                  <span class="folder-item-icon">${itemTypeIcon}</span>
                  <span class="folder-item-title">${escapeHtml(item.title || 'Untitled')}</span>
                  <button class="folder-item-remove" onclick="removeNoteFromFolder(event, '${note.id}', '${itemId}')" title="Remove from folder">×</button>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
  } else if (note.type === 'code') {
    contentHTML = `
      <div class="note-content code-content">
        <div class="code-toolbar">
          <select class="code-language-select" onchange="updateCodeLanguage('${note.id}', this.value)">
            <option value="javascript" ${note.codeLanguage === 'javascript' ? 'selected' : ''}>JavaScript</option>
            <option value="python" ${note.codeLanguage === 'python' ? 'selected' : ''}>Python</option>
            <option value="html" ${note.codeLanguage === 'html' ? 'selected' : ''}>HTML</option>
            <option value="css" ${note.codeLanguage === 'css' ? 'selected' : ''}>CSS</option>
            <option value="json" ${note.codeLanguage === 'json' ? 'selected' : ''}>JSON</option>
            <option value="sql" ${note.codeLanguage === 'sql' ? 'selected' : ''}>SQL</option>
            <option value="bash" ${note.codeLanguage === 'bash' ? 'selected' : ''}>Bash</option>
            <option value="csharp" ${note.codeLanguage === 'csharp' ? 'selected' : ''}>C#</option>
            <option value="cpp" ${note.codeLanguage === 'cpp' ? 'selected' : ''}>C++</option>
            <option value="java" ${note.codeLanguage === 'java' ? 'selected' : ''}>Java</option>
            <option value="php" ${note.codeLanguage === 'php' ? 'selected' : ''}>PHP</option>
            <option value="ruby" ${note.codeLanguage === 'ruby' ? 'selected' : ''}>Ruby</option>
            <option value="go" ${note.codeLanguage === 'go' ? 'selected' : ''}>Go</option>
            <option value="rust" ${note.codeLanguage === 'rust' ? 'selected' : ''}>Rust</option>
            <option value="typescript" ${note.codeLanguage === 'typescript' ? 'selected' : ''}>TypeScript</option>
          </select>
          <button class="code-copy-btn" onclick="copyCodeToClipboard('${note.id}')" title="Copy to clipboard">📋</button>
        </div>
        <div class="code-editor-container">
          <textarea class="code-editor" id="code-editor-${note.id}" placeholder="Enter your code here..." onInput="updateCodeContent('${note.id}', this.value)">${note.codeContent || ''}</textarea>
          <pre class="code-preview" id="code-preview-${note.id}"><code class="language-${note.codeLanguage}">${escapeHtml(note.codeContent || '')}</code></pre>
        </div>
      </div>
    `;
  }
  
  // Build note structure safely using DOM methods
  
  // Create note header
  const noteHeader = document.createElement('div');
  noteHeader.className = 'note-header';
  
  // Create type info section
  const typeInfo = document.createElement('span');
  typeInfo.style.fontSize = '12px';
  typeInfo.style.opacity = '0.7';
  typeInfo.className = 'note-type-info';
  
  // Add type icon
  const typeIconSpan = document.createElement('span');
  typeIconSpan.className = 'note-type-icon';
  typeIconSpan.appendChild(typeIconImg);
  typeInfo.appendChild(typeIconSpan);
  
  // Add type name
  const typeNameSpan = document.createElement('span');
  typeNameSpan.className = 'note-type-name';
  typeNameSpan.textContent = typeName;
  typeInfo.appendChild(typeNameSpan);
  
  // Add title display (hidden by default)
  const titleDisplay = document.createElement('span');
  titleDisplay.className = 'note-title-display';
  titleDisplay.style.display = 'none';
  typeInfo.appendChild(titleDisplay);
  
  // Add todo header button if needed
  if (note.type === 'todo') {
    const todoHeaderAdd = document.createElement('span');
    todoHeaderAdd.className = 'todo-header-add';
    todoHeaderAdd.textContent = '+';
    todoHeaderAdd.title = 'Add new task';
    todoHeaderAdd.onclick = () => addTodo(note.id);
    typeInfo.appendChild(todoHeaderAdd);
  }
  
  noteHeader.appendChild(typeInfo);
  
  // Create note actions section
  const noteActions = document.createElement('div');
  noteActions.className = 'note-actions';
  
  // Create color picker
  const colorPicker = document.createElement('div');
  colorPicker.className = 'color-picker';
  colorPicker.style.backgroundColor = note.color;
  
  const colorOptions = document.createElement('div');
  colorOptions.className = 'color-options';
  
  noteColors.forEach(color => {
    const colorOption = document.createElement('div');
    colorOption.className = 'color-option';
    colorOption.style.backgroundColor = color;
    colorOption.setAttribute('data-color', color);
    colorOptions.appendChild(colorOption);
  });
  
  colorPicker.appendChild(colorOptions);
  noteActions.appendChild(colorPicker);
  
  // Create minimize button
  const minimizeBtn = document.createElement('span');
  minimizeBtn.className = 'note-minimize';
  minimizeBtn.title = 'Collapse/Expand';
  minimizeBtn.textContent = '—';
  noteActions.appendChild(minimizeBtn);
  
  // Create share button if applicable
  if (['text', 'file', 'image', 'paint', 'todo', 'table', 'code'].includes(note.type)) {
    const shareBtn = document.createElement('span');
    shareBtn.className = 'note-share';
    shareBtn.title = 'Share note';
    shareBtn.onclick = () => showShareOptions(note.id);
    
    const shareImg = document.createElement('img');
    shareImg.src = '../media/share.png';
    shareImg.className = 'note-action-icon';
    shareImg.alt = 'Share';
    shareBtn.appendChild(shareImg);
    
    noteActions.appendChild(shareBtn);
  }
  
  // Create email button if applicable
  if (['text', 'paint', 'todo', 'table', 'code'].includes(note.type)) {
    const emailBtn = document.createElement('span');
    emailBtn.className = 'note-email';
    emailBtn.title = 'Email note';
    emailBtn.onclick = () => emailNote(note.id);
    
    const emailImg = document.createElement('img');
    emailImg.src = '../media/emailicon.png';
    emailImg.className = 'note-action-icon';
    emailImg.alt = 'Email';
    emailBtn.appendChild(emailImg);
    
    noteActions.appendChild(emailBtn);
  }
  
  // Create archive button
  const archiveBtn = document.createElement('span');
  archiveBtn.className = 'note-archive';
  archiveBtn.title = 'Archive note';
  archiveBtn.onclick = () => archiveNote(note.id);
  
  const archiveImg = document.createElement('img');
  archiveImg.src = '../media/foldernote.png';
  archiveImg.className = 'note-action-icon';
  archiveImg.alt = 'Archive';
  archiveBtn.appendChild(archiveImg);
  
  noteActions.appendChild(archiveBtn);
  
  // Create close button
  const closeBtn = document.createElement('span');
  closeBtn.className = 'note-close';
  closeBtn.textContent = '×';
  noteActions.appendChild(closeBtn);
  
  noteHeader.appendChild(noteActions);
  noteElement.appendChild(noteHeader);
  
  // Create title input
  const titleInput = document.createElement('input');
  titleInput.className = 'note-title';
  titleInput.placeholder = 'Title...';
  titleInput.value = note.title || '';
  noteElement.appendChild(titleInput);
  
  // Create tags container
  const tagsContainer = document.createElement('div');
  tagsContainer.className = 'note-tags-container';
  
  const tagsInput = document.createElement('input');
  tagsInput.className = 'note-tags-input';
  tagsInput.placeholder = 'Add tags (comma separated)...';
  tagsInput.value = (note.tags || []).join(', ');
  tagsContainer.appendChild(tagsInput);
  
  const tagsDisplay = document.createElement('div');
  tagsDisplay.className = 'note-tags-display';
  
  (note.tags || []).forEach(tag => {
    const tagSpan = document.createElement('span');
    tagSpan.className = 'note-tag';
    tagSpan.textContent = tag;
    tagsDisplay.appendChild(tagSpan);
  });
  
  tagsContainer.appendChild(tagsDisplay);
  noteElement.appendChild(tagsContainer);
  
  // Add content (still using innerHTML for complex content - this will need separate fixing)
  const contentDiv = document.createElement('div');
  contentDiv.innerHTML = contentHTML;
  noteElement.appendChild(contentDiv);
  
  // Create resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'resize-handle resize-se';
  noteElement.appendChild(resizeHandle);
  
  setupNoteEventListeners(noteElement, note);
  
  // Apply collapsed state if needed
  if (note.collapsed) {
    noteElement.classList.add('collapsed');
    
    // Change minimize button to maximize
    const minimizeBtn = noteElement.querySelector('.note-minimize');
    if (minimizeBtn) {
      minimizeBtn.textContent = '□';
      minimizeBtn.title = 'Expand';
    }
    
    // Show title in header if it exists
    const titleDisplay = noteElement.querySelector('.note-title-display');
    const titleInput = noteElement.querySelector('.note-title');
    const noteTitle = note.title || '';
    
    if (noteTitle.trim()) {
      titleDisplay.textContent = ` - ${noteTitle}`;
      titleDisplay.style.display = 'inline';
    }
  }
  
  document.getElementById('notes-container').appendChild(noteElement);
  
  // Hide note if it's in a folder and not currently opened
  if (note.parentFolder && !note.isOpenFromFolder) {
    noteElement.style.display = 'none';
  }
  
  // Focus on title if new note
  if (!note.title && !note.content && note.type === 'text') {
    noteElement.querySelector('.note-title').focus();
  }
  
  // Setup paint canvas if it's a paint note
  if (note.type === 'paint') {
    setupPaintCanvas(note);
  }
  
  // Setup todo note functionality
  if (note.type === 'todo') {
    setupTodoNote(note);
  }
}

function setupNoteEventListeners(noteElement, note) {
  const header = noteElement.querySelector('.note-header');
  const titleInput = noteElement.querySelector('.note-title');
  const colorPicker = noteElement.querySelector('.color-picker');
  const colorOptions = noteElement.querySelector('.color-options');
  const closeBtn = noteElement.querySelector('.note-close');
  const minimizeBtn = noteElement.querySelector('.note-minimize');
  const resizeHandle = noteElement.querySelector('.resize-se');
  
  // Dragging
  header.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.note-actions')) {
      startDragging(e, note);
    }
  });
  
  // Title editing
  titleInput.addEventListener('input', (e) => {
    note.title = e.target.value;
    
    // Update title display if note is collapsed
    if (note.collapsed) {
      const titleDisplay = noteElement.querySelector('.note-title-display');
      const noteTitle = e.target.value.trim();
      
      if (noteTitle) {
        titleDisplay.textContent = ` - ${noteTitle}`;
        titleDisplay.style.display = 'inline';
      } else {
        titleDisplay.style.display = 'none';
        titleDisplay.textContent = '';
      }
    }
    
    saveNotes();
  });
  
  // Tags editing
  const tagsInput = noteElement.querySelector('.note-tags-input');
  tagsInput.addEventListener('input', (e) => {
    const tagString = e.target.value;
    note.tags = tagString.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    
    // Update tags display
    const tagsDisplay = noteElement.querySelector('.note-tags-display');
    tagsDisplay.innerHTML = note.tags.map(tag => `<span class="note-tag">${tag}</span>`).join('');
    
    saveNotes();
  });
  
  // Content editing for text notes
  if (note.type === 'text') {
    const textarea = noteElement.querySelector('.note-content');
    textarea.addEventListener('input', (e) => {
      note.content = e.target.value;
      saveNotes();
      generateAutoTitle(note.id);
    });
  }
  
  // File link handling for file notes
  if (note.type === 'file') {
    const fileLink = noteElement.querySelector('.file-link');
    if (fileLink) {
      fileLink.addEventListener('click', () => {
        const filePath = fileLink.dataset.filePath;
        const noteId = fileLink.dataset.noteId;
        
        if (filePath) {
          openFile(filePath);
        } else if (noteId) {
          selectFile(noteId);
        }
      });
    }
  }
  
  // Color picker
  colorPicker.addEventListener('click', (e) => {
    e.stopPropagation();
    colorOptions.classList.toggle('active');
  });
  
  colorOptions.addEventListener('click', (e) => {
    if (e.target.classList.contains('color-option')) {
      const newColor = e.target.dataset.color;
      note.color = newColor;
      noteElement.style.backgroundColor = newColor;
      colorPicker.style.backgroundColor = newColor;
      colorOptions.classList.remove('active');
      saveNotes();
    }
  });
  
  // Close button
  closeBtn.addEventListener('click', () => {
    if (note.parentFolder) {
      // If note is in a folder, just hide it instead of deleting
      hideNoteFromFolder(note.id);
    } else {
      // If not in folder, delete as normal
      deleteNote(note.id);
    }
  });
  
  // Minimize button (only for reminder notes)
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => toggleNoteCollapse(note.id));
  }
  
  // Resize handle
  resizeHandle.addEventListener('mousedown', (e) => startResizing(e, note));
}

function toggleNoteCollapse(noteId) {
  const noteElement = document.getElementById(noteId);
  const note = notes.find(n => n.id === noteId);
  
  if (noteElement && note) {
    note.collapsed = !note.collapsed;
    
    const titleDisplay = noteElement.querySelector('.note-title-display');
    const typeName = noteElement.querySelector('.note-type-name');
    const titleInput = noteElement.querySelector('.note-title');
    const minimizeBtn = noteElement.querySelector('.note-minimize');
    
    if (note.collapsed) {
      noteElement.classList.add('collapsed');
      
      // Change button to maximize
      minimizeBtn.textContent = '□';
      minimizeBtn.title = 'Expand';
      
      // Show title in header if it exists
      const noteTitle = titleInput ? titleInput.value.trim() : '';
      if (noteTitle) {
        titleDisplay.textContent = ` - ${noteTitle}`;
        titleDisplay.style.display = 'inline';
      }
    } else {
      noteElement.classList.remove('collapsed');
      
      // Change button back to minimize
      minimizeBtn.textContent = '—';
      minimizeBtn.title = 'Collapse/Expand';
      
      // Hide title display when expanded
      titleDisplay.style.display = 'none';
      titleDisplay.textContent = '';
    }
    
    saveNotes();
  }
}

function showImageOptions(noteId) {
  const modal = document.createElement('div');
  modal.className = 'screenshot-modal';
  modal.innerHTML = `
    <h3>Add Image</h3>
    <div style="display: flex; gap: 16px; margin-top: 16px;">
      <button class="toolbar-btn" onclick="selectImage('${noteId}')">
        <span class="btn-icon">📁</span>
        Choose File
      </button>
      <button class="toolbar-btn" onclick="showScreenshotOptions('${noteId}')">
        <span class="btn-icon">📸</span>
        Take Screenshot
      </button>
      <button class="toolbar-btn" onclick="takeAreaScreenshot('${noteId}')">
        <span class="btn-icon">✂️</span>
        Select Area
      </button>
    </div>
    <button class="toolbar-btn" style="margin-top: 16px;" onclick="this.parentElement.remove()">
      Cancel
    </button>
  `;
  document.body.appendChild(modal);
}

async function showScreenshotOptions(noteId) {
  document.querySelector('.screenshot-modal').remove();
  
  const sources = await ipcRenderer.invoke('get-sources');
  
  const modal = document.createElement('div');
  modal.className = 'screenshot-modal';
  modal.innerHTML = `
    <h3>Select Window or Screen</h3>
    <div class="screenshot-sources">
      ${sources.map(source => `
        <div class="screenshot-source" onclick="captureScreenshot('${noteId}', '${source.id}')">
          <img src="${source.thumbnail.toDataURL()}" />
          <span class="screenshot-source-name">${source.name}</span>
        </div>
      `).join('')}
    </div>
    <button class="toolbar-btn" style="margin-top: 16px;" onclick="this.parentElement.remove()">
      Cancel
    </button>
  `;
  document.body.appendChild(modal);
}

async function captureScreenshot(noteId, sourceId) {
  document.querySelector('.screenshot-modal').remove();
  
  try {
    const result = await ipcRenderer.invoke('capture-screenshot', sourceId);
    if (result.success) {
      const note = notes.find(n => n.id === noteId);
      if (note) {
        // Convert data URL to a temporary file path or use it directly
        note.imagePath = result.dataUrl;
        
        // Re-render the note
        const noteElement = document.getElementById(noteId);
        renderNote(note);
        noteElement.remove();
        
        saveNotes();
      }
    } else {
      alert(`Screenshot failed: ${result.error}`);
    }
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    alert('Screenshot capture failed');
  }
}

async function selectFile(noteId) {
  const result = await ipcRenderer.invoke('open-file-dialog');
  if (!result.canceled && result.filePaths.length > 0) {
    const note = notes.find(n => n.id === noteId);
    if (note) {
      note.filePath = result.filePaths[0];
      const noteElement = document.getElementById(noteId);
      renderNote(note);
      noteElement.remove();
      saveNotes();
    }
  }
}

async function selectImage(noteId) {
  const result = await ipcRenderer.invoke('open-image-dialog');
  if (!result.canceled && result.filePaths.length > 0) {
    const note = notes.find(n => n.id === noteId);
    if (note) {
      note.imagePath = result.filePaths[0];
      const noteElement = document.getElementById(noteId);
      renderNote(note);
      noteElement.remove();
      saveNotes();
    }
  }
  document.querySelector('.screenshot-modal')?.remove();
}

async function openFile(filePath) {
  const result = await ipcRenderer.invoke('open-file', filePath);
  if (result.error) {
    alert(`Could not open file: ${result.error}`);
  } else {
    // Close overlay when file opens successfully
    setTimeout(() => {
      ipcRenderer.send('fade-out');
      setTimeout(() => window.close(), 300);
    }, 500); // Small delay to let file open first
  }
}

function startDragging(e, note) {
  isDragging = true;
  activeNote = note;
  
  const noteElement = document.getElementById(note.id);
  const rect = noteElement.getBoundingClientRect();
  
  dragOffset.x = e.clientX - rect.left;
  dragOffset.y = e.clientY - rect.top;
  
  document.addEventListener('mousemove', drag);
  document.addEventListener('mouseup', stopDragging);
}

function drag(e) {
  if (!isDragging || !activeNote) return;
  
  const noteElement = document.getElementById(activeNote.id);
  const newX = e.clientX - dragOffset.x;
  const newY = e.clientY - dragOffset.y;
  
  noteElement.style.left = `${newX}px`;
  noteElement.style.top = `${newY}px`;
  
  activeNote.x = newX;
  activeNote.y = newY;
  
  // Update folder drop zone visual feedback
  updateFolderDropFeedback(e);
}

function stopDragging(e) {
  if (isDragging && activeNote) {
    // Check if dropped over a folder
    const droppedOnFolder = checkFolderDropTarget(e, activeNote);
    
    // If note was in a folder but not dropped on another folder, remove it from the original folder
    if (!droppedOnFolder && activeNote.parentFolder) {
      const folder = notes.find(n => n.id === activeNote.parentFolder);
      if (folder && folder.folderItems) {
        folder.folderItems = folder.folderItems.filter(id => id !== activeNote.id);
        updateFolderDisplay(activeNote.parentFolder);
      }
      activeNote.parentFolder = null;
      
      // Make sure the note is visible when removed from folder
      const noteElement = document.getElementById(activeNote.id);
      if (noteElement) {
        noteElement.style.display = 'block';
      }
    }
    
    saveNotes();
  }
  
  // Clear folder drop feedback
  document.querySelectorAll('.folder-drop-zone.drag-over').forEach(zone => {
    zone.classList.remove('drag-over');
  });
  
  isDragging = false;
  activeNote = null;
  
  document.removeEventListener('mousemove', drag);
  document.removeEventListener('mouseup', stopDragging);
}

function startResizing(e, note) {
  isResizing = true;
  activeNote = note;
  
  resizeStart.width = note.width;
  resizeStart.height = note.height;
  resizeStart.x = e.clientX;
  resizeStart.y = e.clientY;
  
  document.addEventListener('mousemove', resize);
  document.addEventListener('mouseup', stopResizing);
  e.preventDefault();
}

function resize(e) {
  if (!isResizing || !activeNote) return;
  
  const noteElement = document.getElementById(activeNote.id);
  
  const deltaX = e.clientX - resizeStart.x;
  const deltaY = e.clientY - resizeStart.y;
  
  const newWidth = Math.max(200, resizeStart.width + deltaX);
  const newHeight = Math.max(150, resizeStart.height + deltaY);
  
  noteElement.style.width = `${newWidth}px`;
  noteElement.style.height = `${newHeight}px`;
  
  activeNote.width = newWidth;
  activeNote.height = newHeight;
  
  // Update paint canvas if it's a paint note
  if (activeNote.type === 'paint') {
    const canvas = document.getElementById(`canvas-${activeNote.id}`);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      
      // Store current drawing
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      // Update canvas size
      const canvasWidth = newWidth;
      const canvasHeight = newHeight - 80; // Account for header and toolbar
      
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
      
      // Restore drawing
      ctx.putImageData(imageData, 0, 0);
    }
  }
}

function stopResizing() {
  if (isResizing && activeNote) {
    saveNotes();
  }
  
  isResizing = false;
  activeNote = null;
  
  document.removeEventListener('mousemove', resize);
  document.removeEventListener('mouseup', stopResizing);
}

async function deleteNote(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Check if confirmation is needed
  if (appConfig.confirmDelete) {
    const confirmed = await showDeleteConfirmation(note);
    if (!confirmed) {
      return; // User cancelled
    }
  }
  
  // If it's a timer note, stop the timer and close any detached window
  if (note.type === 'timer') {
    stopTimer(noteId);
    if (note.detached) {
      ipcRenderer.invoke('close-timer-window', noteId);
    }
  }
  
  // Remove note from any parent folder
  if (note.parentFolder) {
    const parentFolder = notes.find(n => n.id === note.parentFolder);
    if (parentFolder && parentFolder.folderItems) {
      parentFolder.folderItems = parentFolder.folderItems.filter(id => id !== noteId);
      updateFolderDisplay(note.parentFolder);
    }
  }
  
  // Also check all folders in case the note is referenced without parentFolder set
  notes.forEach(n => {
    if (n.type === 'folder' && n.folderItems && n.folderItems.includes(noteId)) {
      n.folderItems = n.folderItems.filter(id => id !== noteId);
      updateFolderDisplay(n.id);
    }
  });
  
  notes = notes.filter(n => n.id !== noteId);
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    noteElement.remove();
  }
  saveNotes();
}

function saveNotes() {
  // Update current workspace data
  workspaceData[currentWorkspace] = {
    notes: [...notes],
    archivedNotes: [...archivedNotes]
  };
  
  saveWorkspaceData();
}

function saveWorkspaceData() {
  try {
    const dataDir = appConfig.dataPath;
    
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Save home workspace
    const homeNotesPath = path.join(dataDir, 'home-notes.json');
    fs.writeFileSync(
      homeNotesPath,
      JSON.stringify(workspaceData.home, null, 2)
    );
    
    // Save work workspace  
    const workNotesPath = path.join(dataDir, 'work-notes.json');
    fs.writeFileSync(
      workNotesPath,
      JSON.stringify(workspaceData.work, null, 2)
    );
  } catch (error) {
    console.error('Error saving workspace data:', error);
  }
}

function loadNotes() {
  // Load config first
  loadConfig();
  
  // Load workspace preference first
  currentWorkspace = loadWorkspacePreference();
  
  // Load workspace-specific notes
  const homeNotesPath = path.join(appConfig.dataPath, 'home-notes.json');
  const workNotesPath = path.join(appConfig.dataPath, 'work-notes.json');
  
  // Load home workspace data
  if (fs.existsSync(homeNotesPath)) {
    try {
      const homeData = JSON.parse(fs.readFileSync(homeNotesPath, 'utf8'));
      workspaceData.home = {
        notes: homeData.notes || [],
        archivedNotes: homeData.archivedNotes || []
      };
    } catch (error) {
      console.error('Error loading home workspace data:', error);
      workspaceData.home = { notes: [], archivedNotes: [] };
    }
  }
  
  // Load work workspace data
  if (fs.existsSync(workNotesPath)) {
    try {
      const workData = JSON.parse(fs.readFileSync(workNotesPath, 'utf8'));
      workspaceData.work = {
        notes: workData.notes || [],
        archivedNotes: workData.archivedNotes || []
      };
    } catch (error) {
      console.error('Error loading work workspace data:', error);
      workspaceData.work = { notes: [], archivedNotes: [] };
    }
  }
  
  // Check for legacy notes.json file and migrate if needed
  const legacyNotesPath = path.join(appConfig.dataPath, 'notes.json');
  if (fs.existsSync(legacyNotesPath)) {
    try {
      const legacyData = JSON.parse(fs.readFileSync(legacyNotesPath, 'utf8'));
      if (legacyData.notes || legacyData.archivedNotes) {
        // Migrate legacy data to home workspace if home is empty
        if (workspaceData.home.notes.length === 0 && workspaceData.home.archivedNotes.length === 0) {
          workspaceData.home = {
            notes: legacyData.notes || [],
            archivedNotes: legacyData.archivedNotes || []
          };
          // Save the migrated data
          saveWorkspaceData();
          // Remove legacy file
          fs.unlinkSync(legacyNotesPath);
        }
      }
    } catch (error) {
      console.error('Error migrating legacy notes:', error);
      // If there's an error, just skip the migration
    }
  }
  
  // Set current workspace notes
  notes = [...workspaceData[currentWorkspace].notes];
  archivedNotes = [...workspaceData[currentWorkspace].archivedNotes];
  
  notes.forEach(note => {
    // Ensure all notes have required properties
    if (!note.hasOwnProperty('title')) note.title = '';
    if (!note.hasOwnProperty('type')) note.type = 'text';
    if (!note.hasOwnProperty('filePath')) note.filePath = '';
    if (!note.hasOwnProperty('imagePath')) note.imagePath = '';
    if (!note.hasOwnProperty('paintData')) note.paintData = '';
    if (!note.hasOwnProperty('todoItems')) note.todoItems = [];
    if (!note.hasOwnProperty('canvasWidth')) note.canvasWidth = null;
    if (!note.hasOwnProperty('canvasHeight')) note.canvasHeight = null;
    if (!note.hasOwnProperty('reminderDateTime')) note.reminderDateTime = '';
    if (!note.hasOwnProperty('reminderMessage')) note.reminderMessage = '';
    if (!note.hasOwnProperty('reminderTriggered')) note.reminderTriggered = false;
    
    // Reset detached state on load
    if (note.detached) {
      note.detached = false;
    }
    
    // Restart any running timers
    if (note.type === 'timer' && note.timerRunning) {
      startTimer(note.id);
    }
    
    renderNote(note);
  });
}

// Configuration management functions
function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      appConfig = { ...appConfig, ...config };
    }
  } catch (error) {
    console.error('Error loading config:', error);
  }
}

function saveConfig() {
  try {
    // Ensure directory exists
    const configDir = path.dirname(configPath);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(appConfig, null, 2));
  } catch (error) {
    console.error('Error saving config:', error);
  }
}

function getCurrentDataPath() {
  return appConfig.dataPath;
}

async function changeDataFolder() {
  const { dialog, getCurrentWindow } = require('@electron/remote');
  const currentWindow = getCurrentWindow();
  
  const result = await dialog.showOpenDialog(currentWindow, {
    properties: ['openDirectory'],
    title: 'Select Data Folder',
    buttonLabel: 'Select Folder'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const newPath = result.filePaths[0];
    const oldPath = appConfig.dataPath;
    
    // Check if data files exist in the new location
    const homeNotesExist = fs.existsSync(path.join(newPath, 'home-notes.json'));
    const workNotesExist = fs.existsSync(path.join(newPath, 'work-notes.json'));
    
    if (homeNotesExist || workNotesExist) {
      // Data exists in new location
      const choice = await dialog.showMessageBox(currentWindow, {
        type: 'question',
        buttons: ['Use Existing Data', 'Move Current Data', 'Cancel'],
        defaultId: 2,
        message: 'Data files found in the selected folder',
        detail: 'Would you like to use the existing data in this folder, or move your current data there?'
      });
      
      if (choice.response === 0) {
        // Use existing data
        appConfig.dataPath = newPath;
        saveConfig();
        loadNotes();
        updateDataPathDisplay();
      } else if (choice.response === 1) {
        // Move current data
        moveDataToNewLocation(oldPath, newPath);
      }
    } else {
      // No data in new location
      const choice = await dialog.showMessageBox(currentWindow, {
        type: 'question',
        buttons: ['Create New', 'Move Existing', 'Cancel'],
        defaultId: 2,
        message: 'No data files found in the selected folder',
        detail: 'Would you like to create new data files there, or move your existing data?'
      });
      
      if (choice.response === 0) {
        // Create new data
        appConfig.dataPath = newPath;
        saveConfig();
        // Create empty data files
        saveWorkspaceData();
        updateDataPathDisplay();
      } else if (choice.response === 1) {
        // Move existing data
        moveDataToNewLocation(oldPath, newPath);
      }
    }
  }
}

function moveDataToNewLocation(oldPath, newPath) {
  try {
    // Ensure new directory exists
    if (!fs.existsSync(newPath)) {
      fs.mkdirSync(newPath, { recursive: true });
    }
    
    // Move data files
    const filesToMove = ['home-notes.json', 'work-notes.json', 'workspace-preference.json'];
    
    filesToMove.forEach(file => {
      const oldFile = path.join(oldPath, file);
      const newFile = path.join(newPath, file);
      
      if (fs.existsSync(oldFile)) {
        fs.copyFileSync(oldFile, newFile);
      }
    });
    
    // Update config
    appConfig.dataPath = newPath;
    saveConfig();
    
    // Reload notes from new location
    loadNotes();
    updateDataPathDisplay();
    
    const { dialog, getCurrentWindow } = require('@electron/remote');
    dialog.showMessageBox(getCurrentWindow(), {
      type: 'info',
      message: 'Data moved successfully',
      detail: `Your data has been moved to: ${newPath}`
    });
  } catch (error) {
    console.error('Error moving data:', error);
    const { dialog, getCurrentWindow } = require('@electron/remote');
    dialog.showMessageBox(getCurrentWindow(), {
      type: 'error',
      message: 'Error moving data',
      detail: error.message
    });
  }
}

async function resetAllData() {
  const { dialog, getCurrentWindow } = require('@electron/remote');
  const currentWindow = getCurrentWindow();
  
  const choice = await dialog.showMessageBox(currentWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Reset All Data'],
    defaultId: 0,
    message: 'Are you sure you want to reset all data?',
    detail: 'This will permanently delete all your notes and settings. This action cannot be undone.'
  });
  
  if (choice.response === 1) {
    // Clear all data
    workspaceData = {
      home: { notes: [], archivedNotes: [] },
      work: { notes: [], archivedNotes: [] }
    };
    notes = [];
    archivedNotes = [];
    
    // Save empty data
    saveWorkspaceData();
    
    // Clear the display
    document.getElementById('notes-container').innerHTML = '';
    
    // Close settings modal
    closeSettingsModal();
    
    dialog.showMessageBox(currentWindow, {
      type: 'info',
      message: 'Data reset complete',
      detail: 'All notes and settings have been reset.'
    });
  }
}

function updateDataPathDisplay() {
  const pathElement = document.getElementById('current-data-path');
  if (pathElement) {
    pathElement.textContent = `Current data folder: ${getCurrentDataPath()}`;
  }
}

// Hotkey configuration functions
function showHotkeysConfig() {
  const existingModal = document.querySelector('.hotkeys-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.className = 'hotkeys-modal';
  modal.innerHTML = `
    <div class="hotkeys-modal-content">
      <h3>Configure Hotkeys</h3>
      <div class="hotkeys-list">
        <div class="hotkey-item">
          <label>Toggle Overlay:</label>
          <input type="text" 
                 id="hotkey-toggleOverlay" 
                 class="hotkey-input" 
                 value="${escapeHtml(appConfig.hotkeys.toggleOverlay)}" 
                 placeholder="Click and press keys"
                 readonly>
          <button class="hotkey-clear" onclick="clearHotkey('toggleOverlay')">Clear</button>
        </div>
        <div class="hotkey-item">
          <label>New Note:</label>
          <input type="text" 
                 id="hotkey-newNote" 
                 class="hotkey-input" 
                 value="${escapeHtml(appConfig.hotkeys.newNote || '')}" 
                 placeholder="Click and press keys"
                 readonly>
          <button class="hotkey-clear" onclick="clearHotkey('newNote')">Clear</button>
        </div>
        <div class="hotkey-item">
          <label>Search:</label>
          <input type="text" 
                 id="hotkey-search" 
                 class="hotkey-input" 
                 value="${escapeHtml(appConfig.hotkeys.search || '')}" 
                 placeholder="Click and press keys"
                 readonly>
          <button class="hotkey-clear" onclick="clearHotkey('search')">Clear</button>
        </div>
        <div class="hotkey-item">
          <label>Archive:</label>
          <input type="text" 
                 id="hotkey-archive" 
                 class="hotkey-input" 
                 value="${escapeHtml(appConfig.hotkeys.archive || '')}" 
                 placeholder="Click and press keys"
                 readonly>
          <button class="hotkey-clear" onclick="clearHotkey('archive')">Clear</button>
        </div>
      </div>
      <div class="hotkeys-info">
        <small>Click on an input field and press your desired key combination</small>
      </div>
      <div class="hotkeys-buttons">
        <button class="hotkeys-save" onclick="saveHotkeys()">Save</button>
        <button class="hotkeys-cancel" onclick="closeHotkeysConfig()">Cancel</button>
        <button class="hotkeys-reset" onclick="resetHotkeys()">Reset to Defaults</button>
      </div>
    </div>
    <div class="hotkeys-modal-backdrop" onclick="closeHotkeysConfig()"></div>
  `;
  
  document.body.appendChild(modal);
  
  // Add event listeners for hotkey capture
  const inputs = modal.querySelectorAll('.hotkey-input');
  inputs.forEach(input => {
    input.addEventListener('click', function() {
      this.value = 'Press keys...';
      this.classList.add('recording');
    });
    
    input.addEventListener('keydown', function(e) {
      if (!this.classList.contains('recording')) return;
      
      e.preventDefault();
      e.stopPropagation();
      
      // Build the hotkey string
      let keys = [];
      if (e.ctrlKey) keys.push('Ctrl');
      if (e.altKey) keys.push('Alt');
      if (e.shiftKey) keys.push('Shift');
      if (e.metaKey) keys.push('Meta');
      
      // Add the actual key if it's not a modifier
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        // Format the key properly
        let key = e.key;
        if (key.length === 1) {
          key = key.toUpperCase();
        } else {
          // Handle special keys
          key = key.charAt(0).toUpperCase() + key.slice(1);
        }
        keys.push(key);
      }
      
      if (keys.length > 0 && keys.some(k => !['Ctrl', 'Alt', 'Shift', 'Meta'].includes(k))) {
        this.value = keys.join('+');
        this.classList.remove('recording');
      }
    });
    
    input.addEventListener('blur', function() {
      if (this.classList.contains('recording')) {
        this.value = appConfig.hotkeys[this.id.replace('hotkey-', '')] || '';
        this.classList.remove('recording');
      }
    });
  });
}

function closeHotkeysConfig() {
  const modal = document.querySelector('.hotkeys-modal');
  if (modal) {
    modal.remove();
  }
}

function clearHotkey(key) {
  const input = document.getElementById(`hotkey-${key}`);
  if (input) {
    input.value = '';
  }
}

function resetHotkeys() {
  document.getElementById('hotkey-toggleOverlay').value = 'Alt+Q';
  document.getElementById('hotkey-newNote').value = 'Ctrl+Shift+N';
  document.getElementById('hotkey-search').value = 'Ctrl+F';
  document.getElementById('hotkey-archive').value = 'Ctrl+Shift+A';
}

async function saveHotkeys() {
  const newHotkeys = {
    toggleOverlay: document.getElementById('hotkey-toggleOverlay').value || '',
    newNote: document.getElementById('hotkey-newNote').value || '',
    search: document.getElementById('hotkey-search').value || '',
    archive: document.getElementById('hotkey-archive').value || ''
  };
  
  // Check for duplicates
  const values = Object.values(newHotkeys).filter(v => v);
  const uniqueValues = [...new Set(values)];
  if (values.length !== uniqueValues.length) {
    const { dialog, getCurrentWindow } = require('@electron/remote');
    dialog.showMessageBox(getCurrentWindow(), {
      type: 'warning',
      message: 'Duplicate hotkeys detected',
      detail: 'Each hotkey must be unique. Please use different key combinations.'
    });
    return;
  }
  
  // Update config
  appConfig.hotkeys = newHotkeys;
  saveConfig();
  
  // Update hotkeys in main process
  ipcRenderer.invoke('update-hotkeys', newHotkeys);
  
  // Close modal
  closeHotkeysConfig();
  
  const { dialog, getCurrentWindow } = require('@electron/remote');
  dialog.showMessageBox(getCurrentWindow(), {
    type: 'info',
    message: 'Hotkeys saved',
    detail: 'Your hotkey configuration has been updated.'
  });
}

async function takeAreaScreenshot(noteId) {
  document.querySelector('.screenshot-modal')?.remove();
  
  try {
    const bounds = await ipcRenderer.invoke('start-area-screenshot');
    if (bounds) {
      // Get the first screen source for area capture
      const sources = await ipcRenderer.invoke('get-sources');
      const screenSource = sources.find(s => s.name.includes('Screen') || s.name.includes('Entire'));
      
      if (screenSource) {
        const result = await ipcRenderer.invoke('capture-screenshot', screenSource.id, bounds);
        if (result.success) {
          const note = notes.find(n => n.id === noteId);
          if (note) {
            note.imagePath = result.dataUrl;
            
            // Re-render the note
            const noteElement = document.getElementById(noteId);
            renderNote(note);
            noteElement.remove();
            
            saveNotes();
          }
        } else {
          alert(`Screenshot failed: ${result.error}`);
        }
      } else {
        alert('No screen source found for screenshot');
      }
    }
  } catch (error) {
    console.error('Area screenshot failed:', error);
    alert('Area screenshot failed');
  }
}

function setupPaintCanvas(note) {
  const canvas = document.getElementById(`canvas-${note.id}`);
  const ctx = canvas.getContext('2d');
  const noteElement = document.getElementById(note.id);
  
  // Function to update canvas size based on note dimensions
  const updateCanvasSize = () => {
    const noteRect = noteElement.getBoundingClientRect();
    const newWidth = note.width;
    const newHeight = note.height - 80; // Account for header and toolbar
    
    // Store current drawing if canvas exists and has content
    let imageData = null;
    if (canvas.width > 0 && canvas.height > 0) {
      imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    
    // Update canvas dimensions
    canvas.width = newWidth;
    canvas.height = newHeight;
    
    // Set CSS size to match
    canvas.style.width = `${newWidth}px`;
    canvas.style.height = `${newHeight}px`;
    
    // Restore drawing if we had one
    if (imageData) {
      ctx.putImageData(imageData, 0, 0);
    }
    
    // Restore paint data if available
    if (note.paintData) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0);
      };
      img.src = note.paintData;
    }
  };
  
  // Initial canvas size setup
  updateCanvasSize();
  
  // Load existing paint data
  if (note.paintData) {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0);
    };
    img.src = note.paintData;
  }
  
  let isDrawing = false;
  let currentTool = 'brush';
  let currentColor = '#000';
  let currentSize = 3;
  
  // Setup toolbar events
  const toolbar = noteElement.querySelector('.paint-toolbar');
  
  // Tool selection
  toolbar.querySelectorAll('.paint-tool[data-tool]').forEach(tool => {
    tool.addEventListener('click', (e) => {
      toolbar.querySelectorAll('.paint-tool[data-tool]').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      currentTool = e.target.dataset.tool;
      canvas.style.cursor = currentTool === 'eraser' ? 'grab' : 'crosshair';
    });
  });
  
  // Color selection
  toolbar.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
      toolbar.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      e.target.classList.add('active');
      currentColor = e.target.dataset.color;
    });
  });
  
  // Brush size
  const sizeSlider = toolbar.querySelector('.brush-size');
  sizeSlider.addEventListener('input', (e) => {
    currentSize = e.target.value;
  });
  
  // Drawing events
  let lastX = 0;
  let lastY = 0;
  
  canvas.addEventListener('mousedown', (e) => {
    isDrawing = true;
    const rect = canvas.getBoundingClientRect();
    // Since canvas maintains its original size, coordinates are 1:1
    lastX = e.clientX - rect.left;
    lastY = e.clientY - rect.top;
  });
  
  canvas.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    
    const rect = canvas.getBoundingClientRect();
    // Since canvas maintains its original size, coordinates are 1:1
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    ctx.lineWidth = currentSize;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    if (currentTool === 'brush') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = currentColor;
    } else if (currentTool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
    }
    
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    
    lastX = x;
    lastY = y;
  });
  
  canvas.addEventListener('mouseup', () => {
    if (isDrawing) {
      isDrawing = false;
      // Save canvas data
      note.paintData = canvas.toDataURL();
      saveNotes();
    }
  });
  
  canvas.addEventListener('mouseout', () => {
    isDrawing = false;
  });
}

function clearCanvas(noteId) {
  const canvas = document.getElementById(`canvas-${noteId}`);
  const ctx = canvas.getContext('2d');
  const note = notes.find(n => n.id === noteId);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (note) {
    note.paintData = '';
    saveNotes();
  }
}

function setupTodoNote(note) {
  const noteElement = document.getElementById(note.id);
  
  // Auto-resize textarea inputs
  noteElement.querySelectorAll('.todo-text').forEach(textarea => {
    textarea.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = this.scrollHeight + 'px';
    });
    
    // Trigger initial resize
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  });
}

function addTodo(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Save current values from all todo text fields
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    const todoTextElements = noteElement.querySelectorAll('.todo-text');
    todoTextElements.forEach((textarea, index) => {
      if (note.todoItems && note.todoItems[index]) {
        note.todoItems[index].text = textarea.value;
      }
    });
  }
  
  const newTodo = {
    id: Date.now(),
    text: '',
    completed: false
  };
  
  if (!note.todoItems) {
    note.todoItems = [];
  }
  note.todoItems.push(newTodo);
  
  // Update only the todo list content instead of re-rendering entire note
  const todoListElement = noteElement.querySelector('.todo-list');
  if (todoListElement) {
    // Add the new todo item to the existing list
    const newTodoHTML = `
      <li class="todo-item" data-id="${newTodo.id}">
        <div class="todo-checkbox" onclick="toggleTodo('${note.id}', '${newTodo.id}')"></div>
        <textarea class="todo-text" 
                  placeholder="Enter task..." 
                  onblur="updateTodoText('${note.id}', '${newTodo.id}', this.value)"
                  rows="1">${newTodo.text}</textarea>
        <span class="todo-delete" onclick="deleteTodo('${note.id}', '${newTodo.id}')"> × </span>
      </li>
    `;
    todoListElement.insertAdjacentHTML('beforeend', newTodoHTML);
    
    // Focus on the new todo item
    const newTextarea = todoListElement.querySelector(`[data-id="${newTodo.id}"] .todo-text`);
    if (newTextarea) {
      newTextarea.focus();
    }
  }
  
  saveNotes();
  generateAutoTitle(noteId);
}

function deleteTodo(noteId, todoId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.todoItems = note.todoItems.filter(item => item.id != parseInt(todoId));
  
  // Re-render the note
  const noteElement = document.getElementById(noteId);
  noteElement.remove();
  renderNote(note);
  
  saveNotes();
}


function updateTodoProgress(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const completedCount = note.todoItems.filter(item => item.completed).length;
  const totalCount = note.todoItems.length;
  const progressPercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
  
  const progressElement = document.querySelector(`#${noteId} .todo-progress`);
  if (progressElement) {
    progressElement.innerHTML = `
      <span>${completedCount}/${totalCount}</span>
      <div class="todo-progress-bar">
        <div class="todo-progress-fill" style="width: ${progressPercent}%"></div>
      </div>
      <span>${Math.round(progressPercent)}%</span>
    `;
  }
}

async function emailNote(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Prepare email content
  let subject = note.title || 'Note from PhasePad';
  let body = '';
  let attachmentCreated = false;
  let attachmentInfo = '';
  
  // Add title if available
  if (note.title) {
    body += `${note.title}\n${'='.repeat(note.title.length)}\n\n`;
  }
  
  // Add tags if available
  if (note.tags && note.tags.length > 0) {
    body += `Tags: ${note.tags.join(', ')}\n\n`;
  }
  
  // Handle special cases with attachments
  switch (note.type) {
    case 'paint':
      body += `Drawing Note\n\n`;
      if (note.paintData) {
        // Copy image to clipboard
        await copyPaintToClipboard(note);
        attachmentCreated = true;
        attachmentInfo = `\nATTACHMENT INFO:\nYour drawing has been copied to the clipboard.\nSimply paste (Ctrl+V) it into your email as an attachment.\n\n`;
      }
      body += note.content || '';
      break;
      
    case 'text':
      body += note.content || '';
      break;
      
    case 'code':
      body += `Code (${note.codeLanguage || 'Plain'}):\n\n${note.codeContent || ''}`;
      break;
      
    case 'todo':
      body += 'Tasks:\n';
      if (note.todoItems) {
        note.todoItems.forEach(item => {
          body += `${item.completed ? '✓' : '☐'} ${item.text}\n`;
        });
      }
      break;
      
    case 'table':
      body += 'Table Data:\n\n';
      if (note.tableData && note.tableData.length > 0) {
        note.tableData.forEach((row, i) => {
          body += `Row ${i + 1}: ${row.join(' | ')}\n`;
        });
      }
      break;
      
    default:
      body += note.content || '';
  }
  
  // Add attachment info if needed
  body += attachmentInfo;
  
  // Add creation date
  if (note.createdAt) {
    body += `---\nCreated: ${new Date(note.createdAt).toLocaleString()}`;
  }
  body += `\nSent from PhasePad`;
  
  // Show success message if attachment was created (only for paint notes)
  if (attachmentCreated && note.type === 'paint') {
    alert('Drawing copied to clipboard! You can now paste it directly into your email (Ctrl+V).');
  }
  
  // Create mailto link
  const mailtoLink = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  
  // Use a temporary anchor element to trigger the email client without opening a window
  const tempLink = document.createElement('a');
  tempLink.href = mailtoLink;
  tempLink.style.display = 'none';
  document.body.appendChild(tempLink);
  tempLink.click();
  document.body.removeChild(tempLink);
}

async function copyPaintToClipboard(note) {
  if (!note.paintData) return false;
  
  try {
    // Convert base64 data URL to blob
    const response = await fetch(note.paintData);
    const blob = await response.blob();
    
    // Copy to clipboard using the Clipboard API
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': blob
      })
    ]);
    
    return true;
  } catch (error) {
    console.error('Error copying paint to clipboard:', error);
    // Fallback: try to create a temporary download for manual copy
    try {
      const response = await fetch(note.paintData);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(note.title || 'drawing').replace(/[^a-zA-Z0-9]/g, '_')}_drawing.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (fallbackError) {
      console.error('Fallback download also failed:', fallbackError);
      return false;
    }
  }
}


function archiveNote(noteId) {
  const noteIndex = notes.findIndex(n => n.id === noteId);
  if (noteIndex === -1) return;
  
  const note = notes[noteIndex];
  note.archivedAt = new Date().toISOString();
  
  // If it's a timer note, stop the timer and close any detached window
  if (note.type === 'timer') {
    stopTimer(noteId);
    if (note.detached) {
      ipcRenderer.invoke('close-timer-window', noteId);
      note.detached = false;
    }
  }
  
  // Move to archived notes
  archivedNotes.push(note);
  notes.splice(noteIndex, 1);
  
  // Remove from display
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    noteElement.remove();
  }
  
  saveNotes();
}

function restoreNote(noteId) {
  const noteIndex = archivedNotes.findIndex(n => n.id === noteId);
  if (noteIndex === -1) return;
  
  const note = archivedNotes[noteIndex];
  delete note.archivedAt;
  
  // Reset timer state if it's a timer note
  if (note.type === 'timer') {
    note.timerRunning = false;
    note.detached = false;
    // Reset to initial duration
    note.timerRemaining = note.timerDuration;
  }
  
  // Move back to active notes
  notes.push(note);
  archivedNotes.splice(noteIndex, 1);
  
  // Render the restored note
  renderNote(note);
  
  // Update archive panel
  if (isArchivePanelVisible) {
    showArchivePanel();
  }
  
  saveNotes();
}

function toggleArchivePanel() {
  if (isArchivePanelVisible) {
    hideArchivePanel();
  } else {
    showArchivePanel();
  }
}

function showArchivePanel() {
  hideArchivePanel(); // Remove existing panel
  
  const panel = document.createElement('div');
  panel.className = 'archive-panel';
  panel.id = 'archive-panel';
  
  panel.innerHTML = `
    <div class="archive-header">
      <h3 style="margin: 0; font-size: 16px;">Archived Notes</h3>
      <span style="cursor: pointer; font-size: 18px;" onclick="hideArchivePanel()">×</span>
    </div>
    <div id="archive-list">
      ${archivedNotes.length === 0 ? 
        '<p style="text-align: center; opacity: 0.7; font-size: 14px;">No archived notes</p>' :
        archivedNotes.map(note => {
          const preview = note.content || note.title || note.filePath || 'Untitled';
          const escapedPreview = escapeHtml(preview.substring(0, 30)) + (preview.length > 30 ? '...' : '');
          return `
            <div class="archive-item" onclick="restoreNote('${note.id}')">
              <div class="archive-item-info">
                <div class="archive-item-title">${escapeHtml(note.title || 'Untitled')}</div>
                <div class="archive-item-preview">${escapedPreview}</div>
              </div>
              <div class="archive-item-restore" title="Restore note">↶</div>
            </div>
          `;
        }).join('')
      }
    </div>
  `;
  
  document.body.appendChild(panel);
  isArchivePanelVisible = true;
}

function hideArchivePanel() {
  const panel = document.getElementById('archive-panel');
  if (panel) {
    panel.remove();
  }
  isArchivePanelVisible = false;
}

function startReminderChecker() {
  // Check reminders every minute
  reminderCheckInterval = setInterval(checkReminders, 60000);
  // Also check immediately
  checkReminders();
}

function checkReminders() {
  const now = new Date();
  
  notes.forEach(note => {
    if (note.type === 'reminder' && note.reminderDateTime && !note.reminderTriggered) {
      const reminderDate = new Date(note.reminderDateTime);
      
      // Check if reminder time has passed (with 1-minute tolerance)
      if (reminderDate <= now && (now - reminderDate) < 120000) { // 2 minutes tolerance
        triggerReminder(note);
      }
    }
  });
}

function triggerReminder(note) {
  note.reminderTriggered = true;
  saveNotes();
  
  // Show desktop notification
  if (Notification.permission === 'granted') {
    const notification = new Notification('PhasePad Reminder', {
      body: note.reminderMessage || note.title || 'You have a reminder!',
      icon: '../media/LogoWhite.png',
      tag: `reminder-${note.id}`,
      requireInteraction: true
    });
    
    notification.onclick = () => {
      // Show the overlay and focus on the reminder note
      ipcRenderer.invoke('show-overlay-and-focus-note', note.id);
      notification.close();
    };
  }
  
  // Re-render the note to update status
  const noteElement = document.getElementById(note.id);
  if (noteElement) {
    noteElement.remove();
    renderNote(note);
  }
}

function updateReminderDateTime(noteId, dateTimeValue) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // The datetime-local input provides local time, store it as-is
  // It will be interpreted as local time when creating Date objects
  note.reminderDateTime = dateTimeValue;
  note.reminderTriggered = false; // Reset trigger status when date changes
  saveNotes();
  
  // Re-render to update status
  const noteElement = document.getElementById(noteId);
  noteElement.remove();
  renderNote(note);
}

function updateReminderMessage(noteId, message) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.reminderMessage = message;
  if (!note.title && message) {
    note.title = message.substring(0, 30) + (message.length > 30 ? '...' : '');
  }
  saveNotes();
}

function resetReminder(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.reminderTriggered = false;
  saveNotes();
  
  // Re-render to update status
  const noteElement = document.getElementById(noteId);
  noteElement.remove();
  renderNote(note);
}

function testReminder(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Request notification permission if not granted
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        showTestNotification(note);
      }
    });
  } else if (Notification.permission === 'granted') {
    showTestNotification(note);
  } else {
    alert('Notification permission is denied. Please enable notifications in your browser settings.');
  }
}

function showTestNotification(note) {
  const notification = new Notification('PhasePad Test Reminder', {
    body: note.reminderMessage || 'This is a test notification',
    icon: '../media/LogoWhite.png',
    tag: `test-reminder-${note.id}`
  });
  
  notification.onclick = () => {
    ipcRenderer.invoke('show-overlay-and-focus-note', note.id);
    notification.close();
  };
  
  // Auto-close after 5 seconds
  setTimeout(() => {
    notification.close();
  }, 5000);
}

// Request notification permission on startup
if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// Web Note functions
function updateWebUrl(noteId, url) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.webUrl = url;
  saveNotes();
  
  // Update button states
  const noteElement = document.getElementById(noteId);
  const openBtn = noteElement.querySelector('button[onclick*="openWebUrl"]');
  const copyBtn = noteElement.querySelector('button[onclick*="copyWebUrl"]');
  const previewBtn = noteElement.querySelector('button[onclick*="toggleWebPreview"]');
  
  if (openBtn) {
    openBtn.disabled = !url;
  }
  if (copyBtn) {
    copyBtn.disabled = !url;
  }
  if (previewBtn) {
    previewBtn.disabled = !url;
  }
  
  // Update preview iframe
  const iframe = noteElement.querySelector('iframe');
  if (iframe && url) {
    iframe.src = url;
  }
  
  // Generate auto-title if needed
  generateAutoTitle(noteId);
}

function updateWebTitle(noteId, title) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.webTitle = title;
  saveNotes();
  generateAutoTitle(noteId);
}

function updateWebDescription(noteId, description) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.webDescription = description;
  saveNotes();
  generateAutoTitle(noteId);
}

function toggleWebPreview(noteId) {
  const previewElement = document.getElementById(`web-preview-${noteId}`);
  const button = document.querySelector(`button[onclick="toggleWebPreview('${noteId}')"]`);
  
  if (!previewElement || !button) return;
  
  if (previewElement.style.display === 'none') {
    previewElement.style.display = 'block';
    button.textContent = 'Hide Preview';
    
    // Expand note height to accommodate preview
    const noteElement = document.getElementById(noteId);
    const currentHeight = parseInt(noteElement.style.height);
    noteElement.style.height = (currentHeight + 220) + 'px';
  } else {
    previewElement.style.display = 'none';
    button.textContent = 'Preview';
    
    // Shrink note height back
    const noteElement = document.getElementById(noteId);
    const currentHeight = parseInt(noteElement.style.height);
    noteElement.style.height = (currentHeight - 220) + 'px';
  }
}

function openWebUrl(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.webUrl) return;
  
  // Open URL in default browser
  require('electron').shell.openExternal(note.webUrl);
}

function copyWebUrl(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.webUrl) return;
  
  // Copy URL to clipboard
  navigator.clipboard.writeText(note.webUrl).then(() => {
    // Show brief feedback
    const noteElement = document.getElementById(noteId);
    const copyBtn = noteElement.querySelector('button[onclick*="copyWebUrl"]');
    if (copyBtn) {
      const originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      copyBtn.style.background = '#28a745';
      setTimeout(() => {
        copyBtn.textContent = originalText;
        copyBtn.style.background = '';
      }, 1000);
    }
  }).catch(err => {
    console.error('Failed to copy URL:', err);
    alert('Failed to copy URL to clipboard');
  });
}

// Table Note functions
function updateTableCell(noteId, rowIndex, colIndex, value) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.tableData) return;
  
  // Ensure the row exists
  if (!note.tableData[rowIndex]) {
    note.tableData[rowIndex] = [];
  }
  
  // Update the cell value
  note.tableData[rowIndex][colIndex] = value;
  saveNotes();
}

function addTableRow(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.tableData) return;
  
  const colCount = note.tableData[0] ? note.tableData[0].length : 3;
  const newRow = new Array(colCount).fill('');
  note.tableData.push(newRow);
  
  // Re-render the note
  const noteElement = document.getElementById(noteId);
  const newNoteElement = renderNote(note);
  noteElement.remove();
  saveNotes();
}

function addTableColumn(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.tableData) return;
  
  // Add a new column to each row
  note.tableData.forEach(row => {
    row.push('');
  });
  
  // Re-render the note
  const noteElement = document.getElementById(noteId);
  const newNoteElement = renderNote(note);
  noteElement.remove();
  saveNotes();
}

function removeTableRow(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.tableData || note.tableData.length <= 1) return;
  
  note.tableData.pop();
  
  // Re-render the note
  const noteElement = document.getElementById(noteId);
  const newNoteElement = renderNote(note);
  noteElement.remove();
  saveNotes();
}

function removeTableColumn(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.tableData || note.tableData[0].length <= 1) return;
  
  // Remove last column from each row
  note.tableData.forEach(row => {
    if (row.length > 0) {
      row.pop();
    }
  });
  
  // Re-render the note
  const noteElement = document.getElementById(noteId);
  const newNoteElement = renderNote(note);
  noteElement.remove();
  saveNotes();
}

// Location Note functions
function updateLocationName(noteId, name) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.locationName = name;
  saveNotes();
}

function updateLocationAddress(noteId, address) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.locationAddress = address;
  saveNotes();
  
  // Update button states
  const noteElement = document.getElementById(noteId);
  const mapsBtn = noteElement.querySelector('button[onclick*="openLocationMaps"]');
  const copyBtn = noteElement.querySelector('button[onclick*="copyLocationAddress"]');
  
  if (mapsBtn) {
    mapsBtn.disabled = !address;
  }
  if (copyBtn) {
    copyBtn.disabled = !address;
  }
}

function updateLocationNotes(noteId, notes_text) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.locationNotes = notes_text;
  saveNotes();
}

function openLocationMaps(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.locationAddress) return;
  
  // Create a Google Maps URL with the address
  const encodedAddress = encodeURIComponent(note.locationAddress);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodedAddress}`;
  
  // Open in default browser
  require('electron').shell.openExternal(mapsUrl);
}

function copyLocationAddress(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.locationAddress) return;
  
  // Copy address to clipboard
  navigator.clipboard.writeText(note.locationAddress).then(() => {
    // Show brief feedback
    const noteElement = document.getElementById(noteId);
    const copyBtn = noteElement.querySelector('button[onclick*="copyLocationAddress"]');
    if (copyBtn) {
      const originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      copyBtn.style.background = '#28a745';
      setTimeout(() => {
        copyBtn.textContent = originalText;
        copyBtn.style.background = '';
      }, 1000);
    }
  }).catch(err => {
    console.error('Failed to copy address:', err);
    alert('Failed to copy address to clipboard');
  });
}

// Calculator Note functions
let calculatorOperator = '';
let calculatorPrevious = '';
let calculatorWaitingForOperand = false;

function calculatorInput(noteId, input) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const display = document.getElementById(`calc-display-${noteId}`);
  
  if (['+', '-', '*', '/'].includes(input)) {
    handleOperator(noteId, input, display, note);
  } else {
    handleNumber(noteId, input, display, note);
  }
}

function handleNumber(noteId, input, display, note) {
  if (calculatorWaitingForOperand) {
    note.calculatorDisplay = input;
    calculatorWaitingForOperand = false;
  } else {
    note.calculatorDisplay = note.calculatorDisplay === '0' ? input : note.calculatorDisplay + input;
  }
  
  display.textContent = note.calculatorDisplay;
  saveNotes();
}

function handleOperator(noteId, nextOperator, display, note) {
  const inputValue = parseFloat(note.calculatorDisplay);
  
  if (calculatorPrevious === '') {
    calculatorPrevious = inputValue;
  } else if (calculatorOperator) {
    const currentValue = calculatorPrevious || 0;
    const newValue = calculate(currentValue, inputValue, calculatorOperator);
    
    note.calculatorDisplay = `${parseFloat(newValue.toFixed(7))}`;
    display.textContent = note.calculatorDisplay;
    calculatorPrevious = newValue;
  }
  
  calculatorWaitingForOperand = true;
  calculatorOperator = nextOperator;
  saveNotes();
}

function calculate(firstValue, secondValue, operator) {
  switch (operator) {
    case '+':
      return firstValue + secondValue;
    case '-':
      return firstValue - secondValue;
    case '*':
      return firstValue * secondValue;
    case '/':
      return firstValue / secondValue;
    default:
      return secondValue;
  }
}

function calculatorEquals(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const display = document.getElementById(`calc-display-${noteId}`);
  const inputValue = parseFloat(note.calculatorDisplay);
  
  if (calculatorPrevious !== '' && calculatorOperator && !calculatorWaitingForOperand) {
    const newValue = calculate(calculatorPrevious, inputValue, calculatorOperator);
    
    // Add to history
    const calculation = `${calculatorPrevious} ${calculatorOperator} ${inputValue} = ${parseFloat(newValue.toFixed(7))}`;
    if (!note.calculatorHistory) {
      note.calculatorHistory = [];
    }
    note.calculatorHistory.push(calculation);
    
    // Keep only last 10 entries
    if (note.calculatorHistory.length > 10) {
      note.calculatorHistory = note.calculatorHistory.slice(-10);
    }
    
    note.calculatorDisplay = `${parseFloat(newValue.toFixed(7))}`;
    display.textContent = note.calculatorDisplay;
    
    // Update history display
    const historyElement = document.getElementById(`calc-history-${noteId}`);
    if (historyElement) {
      historyElement.innerHTML = note.calculatorHistory.slice(-3).map(entry => `
        <div class="calc-history-entry">${entry}</div>
      `).join('');
    }
    
    calculatorPrevious = '';
    calculatorOperator = '';
    calculatorWaitingForOperand = true;
    
    saveNotes();
  }
}

function calculatorClear(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const display = document.getElementById(`calc-display-${noteId}`);
  
  note.calculatorDisplay = '0';
  display.textContent = note.calculatorDisplay;
  
  calculatorPrevious = '';
  calculatorOperator = '';
  calculatorWaitingForOperand = false;
  
  saveNotes();
}

function calculatorBackspace(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const display = document.getElementById(`calc-display-${noteId}`);
  
  if (note.calculatorDisplay.length > 1) {
    note.calculatorDisplay = note.calculatorDisplay.slice(0, -1);
  } else {
    note.calculatorDisplay = '0';
  }
  
  display.textContent = note.calculatorDisplay;
  saveNotes();
}

// Auto-title generation system
function generateAutoTitle(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Only generate auto-title if user hasn't set a title and has interacted with content
  if (note.title && note.title.trim()) return;
  
  let autoTitle = '';
  
  switch (note.type) {
    case 'text':
      if (note.content && note.content.trim()) {
        autoTitle = note.content.trim().split('\n')[0].substring(0, 30);
        if (note.content.length > 30) autoTitle += '...';
      }
      break;
      
    case 'web':
      if (note.webTitle && note.webTitle.trim()) {
        autoTitle = note.webTitle.trim();
      } else if (note.webUrl) {
        try {
          const url = new URL(note.webUrl);
          autoTitle = url.hostname.replace('www.', '');
        } catch (e) {
          autoTitle = note.webUrl.substring(0, 30);
        }
      }
      break;
      
    case 'location':
      if (note.locationName && note.locationName.trim()) {
        autoTitle = note.locationName.trim();
      } else if (note.locationAddress && note.locationAddress.trim()) {
        autoTitle = note.locationAddress.trim().split(',')[0];
      }
      break;
      
    case 'file':
      if (note.filePath) {
        const path = require('path');
        autoTitle = path.basename(note.filePath);
      }
      break;
      
    case 'todo':
      const totalTasks = note.todoItems ? note.todoItems.length : 0;
      const completedTasks = note.todoItems ? note.todoItems.filter(item => item.completed).length : 0;
      if (totalTasks > 0) {
        autoTitle = `Todo List (${completedTasks}/${totalTasks})`;
      }
      break;
      
    case 'reminder':
      if (note.reminderMessage && note.reminderMessage.trim()) {
        autoTitle = note.reminderMessage.trim().substring(0, 30);
        if (note.reminderMessage.length > 30) autoTitle += '...';
      } else if (note.reminderDateTime) {
        const date = new Date(note.reminderDateTime);
        autoTitle = `Reminder for ${date.toLocaleDateString()}`;
      }
      break;
      
    case 'table':
      if (note.tableData && note.tableData.length > 0) {
        const firstRow = note.tableData[0];
        if (firstRow && firstRow[0] && firstRow[0].trim()) {
          autoTitle = firstRow[0].trim().substring(0, 30);
          if (firstRow[0].length > 30) autoTitle += '...';
        } else {
          autoTitle = `Table (${note.tableData.length} rows)`;
        }
      }
      break;
      
    case 'calculator':
      if (note.calculatorHistory && note.calculatorHistory.length > 0) {
        autoTitle = 'Calculator';
      }
      break;
      
    case 'paint':
      autoTitle = 'Drawing';
      break;
      
    case 'image':
      if (note.imagePath) {
        const path = require('path');
        autoTitle = path.basename(note.imagePath);
      }
      break;
      
    case 'timer':
      switch (note.timerType) {
        case 'pomodoro':
          autoTitle = 'Pomodoro Timer';
          break;
        case 'short-break':
          autoTitle = 'Short Break';
          break;
        case 'long-break':
          autoTitle = 'Long Break';
          break;
        case 'custom':
          autoTitle = `${Math.floor(note.timerDuration / 60)} min Timer`;
          break;
      }
      break;
      
    case 'code':
      if (note.codeContent && note.codeContent.trim()) {
        // Try to extract a function name or first meaningful line
        const lines = note.codeContent.split('\n').filter(line => line.trim());
        if (lines.length > 0) {
          const firstLine = lines[0].trim();
          // Look for function definitions
          const funcMatch = firstLine.match(/(?:function|def|class|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
          if (funcMatch) {
            autoTitle = `${note.codeLanguage.toUpperCase()}: ${funcMatch[1]}`;
          } else {
            autoTitle = `${note.codeLanguage.toUpperCase()}: ${firstLine.substring(0, 25)}${firstLine.length > 25 ? '...' : ''}`;
          }
        } else {
          autoTitle = `${note.codeLanguage.toUpperCase()} Code`;
        }
      }
      break;
  }
  
  // Update the title display in collapsed view
  if (autoTitle) {
    updateNoteTitleDisplay(noteId, autoTitle);
  }
}

function updateNoteTitleDisplay(noteId, title) {
  const noteElement = document.getElementById(noteId);
  if (!noteElement) return;
  
  const titleDisplay = noteElement.querySelector('.note-title-display');
  if (titleDisplay && noteElement.classList.contains('collapsed')) {
    titleDisplay.textContent = ` - ${title}`;
    titleDisplay.style.display = 'inline';
  }
}

// Add auto-title generation to other note type updates
function updateTodoText(noteId, todoId, text) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const todoItem = note.todoItems.find(item => item.id === parseInt(todoId));
  if (todoItem) {
    todoItem.text = text;
    saveNotes();
    generateAutoTitle(noteId);
  }
}

function toggleTodo(noteId, todoId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const todoItem = note.todoItems.find(item => item.id === parseInt(todoId));
  if (todoItem) {
    todoItem.completed = !todoItem.completed;
    
    const checkbox = document.querySelector(`[data-id="${todoId}"] .todo-checkbox`);
    const textElement = document.querySelector(`[data-id="${todoId}"] .todo-text`);
    
    if (checkbox) {
      if (todoItem.completed) {
        checkbox.classList.add('checked');
        checkbox.textContent = '✓';
      } else {
        checkbox.classList.remove('checked');
        checkbox.textContent = '';
      }
    }
    
    if (textElement) {
      if (todoItem.completed) {
        textElement.classList.add('completed');
      } else {
        textElement.classList.remove('completed');
      }
    }
    
    // Update progress bar
    updateTodoProgress(noteId);
    saveNotes();
    generateAutoTitle(noteId);
  }
}

// Update other functions to trigger auto-title
function updateReminderMessage(noteId, message) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.reminderMessage = message;
  saveNotes();
  generateAutoTitle(noteId);
}

function updateLocationName(noteId, name) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.locationName = name;
  saveNotes();
  generateAutoTitle(noteId);
}

function updateLocationAddress(noteId, address) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.locationAddress = address;
  saveNotes();
  
  // Update button states
  const noteElement = document.getElementById(noteId);
  const mapsBtn = noteElement.querySelector('button[onclick*="openLocationMaps"]');
  const copyBtn = noteElement.querySelector('button[onclick*="copyLocationAddress"]');
  
  if (mapsBtn) {
    mapsBtn.disabled = !address;
  }
  if (copyBtn) {
    copyBtn.disabled = !address;
  }
  
  generateAutoTitle(noteId);
}

function updateTableCell(noteId, rowIndex, colIndex, value) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.tableData) return;
  
  // Ensure the row exists
  if (!note.tableData[rowIndex]) {
    note.tableData[rowIndex] = [];
  }
  
  // Update the cell value
  note.tableData[rowIndex][colIndex] = value;
  saveNotes();
  generateAutoTitle(noteId);
}

// Timer Note functions
const timers = {};

function setTimerPreset(noteId, type, minutes) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.timerType = type;
  note.timerDuration = minutes * 60;
  note.timerRemaining = minutes * 60;
  note.timerRunning = false;
  
  // Update display
  updateTimerDisplay(noteId);
  
  // Update preset buttons
  const noteElement = document.getElementById(noteId);
  noteElement.querySelectorAll('.timer-preset').forEach(btn => {
    btn.classList.remove('active');
  });
  noteElement.querySelector(`.timer-preset[onclick*="${type}"]`).classList.add('active');
  
  // Update custom input
  document.getElementById(`timer-input-${noteId}`).value = minutes;
  
  // Reset button text
  document.getElementById(`timer-btn-${noteId}`).textContent = 'Start';
  
  saveNotes();
}

function setCustomTimer(noteId, minutes) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const min = Math.max(1, Math.min(999, parseInt(minutes) || 1));
  note.timerType = 'custom';
  note.timerDuration = min * 60;
  note.timerRemaining = min * 60;
  note.timerRunning = false;
  
  // Update display
  updateTimerDisplay(noteId);
  
  // Update preset buttons
  const noteElement = document.getElementById(noteId);
  noteElement.querySelectorAll('.timer-preset').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Reset button text
  document.getElementById(`timer-btn-${noteId}`).textContent = 'Start';
  
  saveNotes();
}

function toggleTimer(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.timerRunning = !note.timerRunning;
  
  const button = document.getElementById(`timer-btn-${noteId}`);
  if (button) {
    button.textContent = note.timerRunning ? 'Pause' : 'Start';
  }
  
  if (note.timerRunning) {
    startTimer(noteId);
  } else {
    stopTimer(noteId);
  }
  
  // Update detached window if exists
  if (note.detached) {
    ipcRenderer.invoke('update-timer-window', noteId, {
      timerRunning: note.timerRunning,
      timerRemaining: note.timerRemaining
    });
  }
  
  saveNotes();
}

function startTimer(noteId) {
  if (timers[noteId]) return;
  
  timers[noteId] = setInterval(() => {
    const note = notes.find(n => n.id === noteId);
    if (!note || !note.timerRunning) {
      stopTimer(noteId);
      return;
    }
    
    note.timerRemaining--;
    
    if (note.timerRemaining <= 0) {
      note.timerRemaining = 0;
      note.timerRunning = false;
      stopTimer(noteId);
      
      // Play notification sound and show alert
      playTimerSound();
      showTimerNotification(note);
      
      document.getElementById(`timer-btn-${noteId}`).textContent = 'Start';
    }
    
    updateTimerDisplay(noteId);
    updateTimerProgress(noteId);
    
    // Update detached window if exists
    if (note.detached) {
      ipcRenderer.invoke('update-timer-window', noteId, {
        timerRemaining: note.timerRemaining,
        timerRunning: note.timerRunning
      });
    }
    
    saveNotes();
  }, 1000);
}

function stopTimer(noteId) {
  if (timers[noteId]) {
    clearInterval(timers[noteId]);
    delete timers[noteId];
  }
}

function resetTimer(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.timerRemaining = note.timerDuration;
  note.timerRunning = false;
  
  stopTimer(noteId);
  updateTimerDisplay(noteId);
  updateTimerProgress(noteId);
  
  document.getElementById(`timer-btn-${noteId}`).textContent = 'Start';
  
  saveNotes();
}

function updateTimerDisplay(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const display = document.getElementById(`timer-display-${noteId}`);
  if (!display) return;
  
  const minutes = Math.floor(note.timerRemaining / 60);
  const seconds = note.timerRemaining % 60;
  display.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimerProgress(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  const progressBar = document.getElementById(`timer-progress-${noteId}`);
  if (!progressBar) return;
  
  const progress = ((note.timerDuration - note.timerRemaining) / note.timerDuration) * 100;
  progressBar.style.width = `${progress}%`;
}

function playTimerSound() {
  // Create a simple beep sound
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  oscillator.frequency.value = 800;
  oscillator.type = 'sine';
  
  gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
  
  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + 0.5);
}

function showTimerNotification(note) {
  let message = 'Timer completed!';
  
  switch (note.timerType) {
    case 'pomodoro':
      message = 'Pomodoro session completed! Time for a break.';
      break;
    case 'short-break':
      message = 'Short break over! Ready to focus again?';
      break;
    case 'long-break':
      message = 'Long break finished! Feeling refreshed?';
      break;
  }
  
  if (Notification.permission === 'granted') {
    const notification = new Notification('PhasePad Timer', {
      body: message,
      icon: '../media/LogoWhite.png',
      tag: `timer-${note.id}`
    });
    
    notification.onclick = () => {
      ipcRenderer.invoke('show-overlay-and-focus-note', note.id);
      notification.close();
    };
  }
}

// Auto-title for timer notes
function generateTimerAutoTitle(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || note.type !== 'timer') return;
  
  if (!note.title || !note.title.trim()) {
    let autoTitle = '';
    switch (note.timerType) {
      case 'pomodoro':
        autoTitle = 'Pomodoro Timer';
        break;
      case 'short-break':
        autoTitle = 'Short Break';
        break;
      case 'long-break':
        autoTitle = 'Long Break';
        break;
      case 'custom':
        autoTitle = `${Math.floor(note.timerDuration / 60)} min Timer`;
        break;
    }
    updateNoteTitleDisplay(noteId, autoTitle);
  }
}

// Function to manually detach a timer
function detachTimer(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.timerRunning) return;
  
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    const rect = noteElement.getBoundingClientRect();
    ipcRenderer.invoke('create-timer-window', {
      id: note.id,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      title: note.title || getTimerAutoTitle(note),
      timerType: note.timerType,
      timerDuration: note.timerDuration,
      timerRemaining: note.timerRemaining,
      timerRunning: note.timerRunning
    });
    note.detached = true;
    
    // Hide overlay after detaching
    setTimeout(() => {
      ipcRenderer.send('fade-out');
    }, 300);
    
    saveNotes();
  }
}

// Folder functionality
function updateFolderDropFeedback(event) {
  // Remove existing drag-over classes
  document.querySelectorAll('.folder-drop-zone.drag-over').forEach(zone => {
    zone.classList.remove('drag-over');
  });
  
  if (!isDragging || !activeNote) return;
  
  // Temporarily hide the dragged note to get element below it
  const draggedElement = document.getElementById(activeNote.id);
  const originalDisplay = draggedElement ? draggedElement.style.display : null;
  if (draggedElement) {
    draggedElement.style.display = 'none';
  }
  
  // Get element under cursor
  const elementBelow = document.elementFromPoint(event.clientX, event.clientY);
  
  // Restore the dragged note's visibility
  if (draggedElement && originalDisplay !== null) {
    draggedElement.style.display = originalDisplay;
  }
  
  if (!elementBelow) return;
  
  // Find folder drop zone
  const folderDropZone = elementBelow.closest('.folder-drop-zone');
  if (folderDropZone) {
    const folderId = folderDropZone.getAttribute('data-folder-id');
    
    // Don't highlight if it's the same note or invalid drop target
    if (folderId && folderId !== activeNote.id) {
      const folder = notes.find(n => n.id === folderId);
      if (folder && folder.type === 'folder') {
        // Check for circular reference
        if (activeNote.type !== 'folder' || !isNoteInFolderHierarchy(folderId, activeNote.id)) {
          folderDropZone.classList.add('drag-over');
        }
      }
    }
  }
}

function checkFolderDropTarget(event, draggedNote) {
  if (!event || !draggedNote) return false;
  
  // Temporarily hide the dragged note to get element below it
  const draggedElement = document.getElementById(draggedNote.id);
  const originalDisplay = draggedElement ? draggedElement.style.display : null;
  if (draggedElement) {
    draggedElement.style.display = 'none';
  }
  
  // Get the element at the mouse position
  const elementBelow = document.elementFromPoint(event.clientX, event.clientY);
  
  // Restore the dragged note's visibility
  if (draggedElement && originalDisplay !== null) {
    draggedElement.style.display = originalDisplay;
  }
  
  if (!elementBelow) return false;
  
  // Find if we're over a folder drop zone
  const folderDropZone = elementBelow.closest('.folder-drop-zone');
  if (!folderDropZone) return false;
  
  // Get the folder ID from the drop zone
  const folderId = folderDropZone.getAttribute('data-folder-id');
  if (!folderId || folderId === draggedNote.id) return false;
  
  const folder = notes.find(n => n.id === folderId);
  if (!folder || folder.type !== 'folder') return false;
  
  // Prevent circular references
  if (draggedNote.type === 'folder' && (draggedNote.id === folderId || isNoteInFolderHierarchy(folderId, draggedNote.id))) {
    return false;
  }
  
  // Add note to folder
  if (draggedFolderItem && sourceFolder) {
    // This is a folder item being moved between folders
    addNoteToFolder(draggedFolderItem, folderId);
  } else if (draggedNote) {
    // This is a regular note being added to a folder
    addNoteToFolder(draggedNote.id, folderId);
  }
  
  return true; // Note was dropped on a folder
}

function addNoteToFolder(noteId, folderId) {
  const note = notes.find(n => n.id === noteId);
  const folder = notes.find(n => n.id === folderId);
  
  if (!note || !folder || folder.type !== 'folder') return;
  
  // Remove note from current folder if it's already in one
  if (note.parentFolder) {
    const currentFolder = notes.find(n => n.id === note.parentFolder);
    if (currentFolder && currentFolder.folderItems) {
      currentFolder.folderItems = currentFolder.folderItems.filter(id => id !== noteId);
      updateFolderDisplay(note.parentFolder);
    }
  }
  
  // Add note to new folder
  if (!folder.folderItems) folder.folderItems = [];
  if (!folder.folderItems.includes(noteId)) {
    folder.folderItems.push(noteId);
  }
  
  // Set parent folder reference
  note.parentFolder = folderId;
  
  // Hide the note from main view
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    noteElement.style.display = 'none';
  }
  
  // Update folder display
  updateFolderDisplay(folderId);
  
  saveNotes();
}

function isNoteInFolderHierarchy(checkFolderId, targetNoteId) {
  const checkFolder = notes.find(n => n.id === checkFolderId);
  if (!checkFolder || !checkFolder.folderItems) return false;
  
  return checkFolder.folderItems.some(itemId => {
    if (itemId === targetNoteId) return true;
    const item = notes.find(n => n.id === itemId);
    if (item && item.type === 'folder') {
      return isNoteInFolderHierarchy(itemId, targetNoteId);
    }
    return false;
  });
}

function updateFolderDisplay(folderId) {
  const folder = notes.find(n => n.id === folderId);
  if (!folder || folder.type !== 'folder') return;
  
  const folderItemsContainer = document.getElementById(`folder-items-${folderId}`);
  const folderCountSpan = document.querySelector(`#${folderId} .folder-count`);
  
  if (folderItemsContainer) {
    // Clear existing content
    folderItemsContainer.innerHTML = '';
    
    (folder.folderItems || []).forEach(itemId => {
      const item = notes.find(n => n.id === itemId) || archivedNotes.find(n => n.id === itemId);
      if (!item) return;
      
      // Create elements safely using DOM methods
      const folderItem = document.createElement('div');
      folderItem.className = 'folder-item';
      folderItem.draggable = true;
      folderItem.title = item.title || 'Untitled';
      folderItem.onclick = () => focusNoteFromFolder(itemId);
      folderItem.onmousedown = (event) => startFolderItemDrag(event, itemId, folderId);
      folderItem.ondragstart = (event) => handleFolderItemDragStart(event, itemId, folderId);
      folderItem.ondragend = (event) => handleFolderItemDragEnd(event);
      
      // Create icon span with img element
      const iconSpan = document.createElement('span');
      iconSpan.className = 'folder-item-icon';
      const iconImg = document.createElement('img');
      iconImg.src = getNoteTypeIcon(item.type);
      iconImg.className = 'note-type-icon-img';
      iconImg.alt = item.type;
      iconSpan.appendChild(iconImg);
      
      // Create title span
      const titleSpan = document.createElement('span');
      titleSpan.className = 'folder-item-title';
      titleSpan.textContent = item.title || 'Untitled';
      
      // Create remove button
      const removeButton = document.createElement('button');
      removeButton.className = 'folder-item-remove';
      removeButton.textContent = '×';
      removeButton.title = 'Remove from folder';
      removeButton.onclick = (event) => removeNoteFromFolder(event, folderId, itemId);
      
      // Assemble the folder item
      folderItem.appendChild(iconSpan);
      folderItem.appendChild(titleSpan);
      folderItem.appendChild(removeButton);
      
      folderItemsContainer.appendChild(folderItem);
    });
  }
  
  if (folderCountSpan) {
    folderCountSpan.textContent = `${(folder.folderItems || []).length} items`;
  }
}

function focusNoteFromFolder(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Mark note as opened from folder
  note.isOpenFromFolder = true;
  
  // Create the note element if it doesn't exist or was hidden
  let noteElement = document.getElementById(noteId);
  if (!noteElement) {
    // Re-create the note element
    renderNote(note);
    noteElement = document.getElementById(noteId);
  }
  
  if (noteElement) {
    // Make sure the note is visible
    noteElement.style.display = 'block';
    noteElement.style.visibility = 'visible';
    noteElement.style.opacity = '1';
    
    // Bring note to front
    const allNotes = document.querySelectorAll('.note');
    const maxZ = Math.max(...Array.from(allNotes).map(n => parseInt(n.style.zIndex || 1)));
    noteElement.style.zIndex = maxZ + 1;
    
    // Scroll to the note and highlight it
    noteElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Add a temporary highlight effect
    noteElement.style.boxShadow = '0 0 20px rgba(74, 144, 226, 0.8)';
    setTimeout(() => {
      noteElement.style.boxShadow = '';
    }, 1000);
  }
}

function hideNoteFromFolder(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (note) {
    // Clear the opened from folder flag
    note.isOpenFromFolder = false;
  }
  
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    noteElement.style.display = 'none';
  }
}

function removeNoteFromFolder(event, folderId, noteId) {
  event.stopPropagation();
  
  const folder = notes.find(n => n.id === folderId);
  const note = notes.find(n => n.id === noteId);
  
  if (!folder || !note) return;
  
  // Remove from folder
  if (folder.folderItems) {
    folder.folderItems = folder.folderItems.filter(id => id !== noteId);
  }
  
  // Clear parent reference
  note.parentFolder = null;
  
  // Show the note again in main view
  const noteElement = document.getElementById(noteId);
  if (noteElement) {
    noteElement.style.display = 'block';
  }
  
  // Update folder display
  updateFolderDisplay(folderId);
  
  saveNotes();
}

// Code note functionality
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateCodeContent(noteId, content) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.codeContent = content;
  
  // Update preview
  const preview = document.getElementById(`code-preview-${noteId}`);
  const code = preview.querySelector('code');
  if (code) {
    code.textContent = content;
    // Trigger syntax highlighting if Prism.js is available
    if (typeof Prism !== 'undefined') {
      Prism.highlightElement(code);
    }
  }
  
  saveNotes();
  generateAutoTitle(noteId);
}

function updateCodeLanguage(noteId, language) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  note.codeLanguage = language;
  
  // Update preview language
  const preview = document.getElementById(`code-preview-${noteId}`);
  const code = preview.querySelector('code');
  if (code) {
    code.className = `language-${language}`;
    // Trigger syntax highlighting if Prism.js is available
    if (typeof Prism !== 'undefined') {
      Prism.highlightElement(code);
    }
  }
  
  saveNotes();
}

function copyCodeToClipboard(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note || !note.codeContent) return;
  
  navigator.clipboard.writeText(note.codeContent).then(() => {
    // Show visual feedback
    const btn = document.querySelector(`#${noteId} .code-copy-btn`);
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = '✅';
      setTimeout(() => {
        btn.textContent = originalText;
      }, 1500);
    }
  }).catch(err => {
    console.error('Failed to copy code:', err);
  });
}

// Share functionality  
function showShareOptions(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Create share modal
  const existingModal = document.querySelector('.share-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.className = 'share-modal';
  modal.innerHTML = `
    <div class="share-modal-content">
      <h3>Share Note</h3>
      <p><strong>${escapeHtml(note.title || 'Untitled Note')}</strong></p>
      <div class="share-options">
        <button class="share-btn" onclick="exportAsMarkdown('${noteId}')">
          📝 Save as Markdown
        </button>
        <button class="share-btn" onclick="exportAsJSON('${noteId}')">
          📋 Save as JSON
        </button>
        ${['image', 'paint', 'table'].includes(note.type) ? 
          `<button class="share-btn" onclick="exportAsPNG('${noteId}')">🖼️ Export as PNG</button>` : ''}
        <button class="share-btn" onclick="copyToClipboard('${noteId}')">
          📋 Copy to Clipboard
        </button>
        <div class="share-divider">Share Options</div>
        <button class="share-btn" onclick="createShareableFile('${noteId}')">
          🔗 Create Shareable File
        </button>
        <button class="share-btn" onclick="generateShareText('${noteId}')">
          📱 Generate Share Text
        </button>
      </div>
      <button class="share-close" onclick="closeShareModal()">Close</button>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close modal when clicking outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeShareModal();
    }
  });
}

function closeShareModal() {
  const modal = document.querySelector('.share-modal');
  if (modal) {
    modal.remove();
  }
}

function exportAsMarkdown(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  let markdown = '';
  
  // Title
  if (note.title) {
    markdown += `# ${note.title}\n\n`;
  }
  
  // Tags
  if (note.tags && note.tags.length > 0) {
    markdown += `**Tags:** ${note.tags.join(', ')}\n\n`;
  }
  
  // Content based on note type
  switch (note.type) {
    case 'text':
      markdown += note.content || '';
      break;
    case 'code':
      markdown += `## Code (${note.codeLanguage})\n\n`;
      markdown += '```' + note.codeLanguage + '\n';
      markdown += note.codeContent || '';
      markdown += '\n```';
      break;
    case 'todo':
      markdown += '## Tasks\n\n';
      if (note.todoItems) {
        note.todoItems.forEach(item => {
          markdown += `- [${item.completed ? 'x' : ' '}] ${item.text}\n`;
        });
      }
      break;
    case 'web':
      if (note.webUrl) markdown += `**URL:** [${note.webTitle || note.webUrl}](${note.webUrl})\n\n`;
      if (note.webDescription) markdown += note.webDescription;
      break;
    case 'location':
      if (note.locationName) markdown += `**Location:** ${note.locationName}\n\n`;
      if (note.locationAddress) markdown += `**Address:** ${note.locationAddress}\n\n`;
      if (note.locationNotes) markdown += note.locationNotes;
      break;
    case 'reminder':
      if (note.reminderDateTime) {
        markdown += `**Reminder:** ${new Date(note.reminderDateTime).toLocaleString()}\n\n`;
      }
      if (note.reminderMessage) markdown += note.reminderMessage;
      break;
    case 'folder':
      markdown += '## Folder Contents\n\n';
      if (note.folderItems && note.folderItems.length > 0) {
        note.folderItems.forEach(itemId => {
          const item = notes.find(n => n.id === itemId) || archivedNotes.find(n => n.id === itemId);
          if (item) {
            markdown += `- ${item.title || 'Untitled'} (${item.type})\n`;
          }
        });
      }
      break;
    default:
      markdown += note.content || '';
  }
  
  // Save to file
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(note.title || 'note').replace(/[^a-zA-Z0-9]/g, '_')}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  closeShareModal();
}

function exportAsJSON(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Create clean export object
  const exportData = {
    id: note.id,
    type: note.type,
    title: note.title,
    content: note.content,
    tags: note.tags,
    createdAt: new Date().toISOString(),
    ...getTypeSpecificData(note)
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(note.title || 'note').replace(/[^a-zA-Z0-9]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  closeShareModal();
}

function getTypeSpecificData(note) {
  const data = {};
  
  switch (note.type) {
    case 'code':
      data.codeContent = note.codeContent;
      data.codeLanguage = note.codeLanguage;
      break;
    case 'todo':
      data.todoItems = note.todoItems;
      break;
    case 'web':
      data.webUrl = note.webUrl;
      data.webTitle = note.webTitle;
      data.webDescription = note.webDescription;
      break;
    case 'location':
      data.locationName = note.locationName;
      data.locationAddress = note.locationAddress;
      data.locationNotes = note.locationNotes;
      break;
    case 'reminder':
      data.reminderDateTime = note.reminderDateTime;
      data.reminderMessage = note.reminderMessage;
      break;
    case 'folder':
      data.folderItems = note.folderItems;
      break;
  }
  
  return data;
}

function showSettingsModal() {
  // Create settings modal
  const existingModal = document.querySelector('.settings-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-modal-content">
      <h3>PhasePad Settings</h3>
      <div class="settings-section">
        <h4>General</h4>
        <div class="settings-options">
          <div class="settings-toggle-item">
            <label class="settings-toggle">
              <input type="checkbox" id="startup-toggle">
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-toggle-label">Start with Windows</span>
          </div>
          <div class="settings-toggle-item">
            <label class="settings-toggle">
              <input type="checkbox" id="confirm-delete-toggle">
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-toggle-label">Confirm before deleting notes</span>
          </div>
          <div class="settings-toggle-item">
            <label class="settings-toggle">
              <input type="checkbox" id="check-updates-toggle">
              <span class="settings-toggle-slider"></span>
            </label>
            <span class="settings-toggle-label">Check for updates automatically</span>
          </div>
        </div>
        <div class="settings-info">
          <small>Customize PhasePad behavior and notifications</small>
        </div>
      </div>
      <div class="settings-section">
        <h4>Hotkeys</h4>
        <div class="settings-options">
          <button class="settings-btn" onclick="showHotkeysConfig()">
            ⌨️ Configure Hotkeys
          </button>
        </div>
        <div class="settings-info">
          <small>Customize keyboard shortcuts for PhasePad</small>
        </div>
      </div>
      <div class="settings-section">
        <h4>Data Management</h4>
        <div class="settings-options">
          <button class="settings-btn" onclick="changeDataFolder()">
            📁 Change Data Folder
          </button>
          <button class="settings-btn reset-btn" onclick="resetAllData()">
            🗑️ Reset All Data
          </button>
        </div>
        <div class="settings-info">
          <small id="current-data-path">Current data folder: ${getCurrentDataPath()}</small>
        </div>
      </div>
      <div class="settings-section">
        <h4>Import & Export</h4>
        <div class="settings-options">
          <button class="settings-btn" onclick="importFromJSON()">
            📥 Import JSON Notes
          </button>
          <button class="settings-btn" onclick="exportAllAsJSON()">
            💾 Export All Notes (Backup)
          </button>
          <button class="settings-btn" onclick="importFromMarkdown()">
            📝 Import Markdown Files
          </button>
        </div>
        <div class="settings-info">
          <small>Import notes from backup files or export all your notes for backup.</small>
        </div>
      </div>
      <div class="settings-section">
        <h4>About</h4>
        <div class="settings-info">
          <small>PhasePad - Desktop sticky notes application<br>
          Version 1.0.2</small>
        </div>
      </div>
      <button class="settings-close" onclick="closeSettingsModal()">Close</button>
    </div>
    <div class="settings-modal-backdrop" onclick="closeSettingsModal()"></div>
  `;
  
  document.body.appendChild(modal);
  
  // Load and set startup toggle state
  loadStartupToggleState();
  
  // Add event listener for startup toggle
  const startupToggle = document.getElementById('startup-toggle');
  if (startupToggle) {
    startupToggle.addEventListener('change', handleStartupToggle);
  }
  
  // Set and handle confirm delete toggle
  const confirmDeleteToggle = document.getElementById('confirm-delete-toggle');
  if (confirmDeleteToggle) {
    confirmDeleteToggle.checked = appConfig.confirmDelete !== false;
    confirmDeleteToggle.addEventListener('change', (e) => {
      appConfig.confirmDelete = e.target.checked;
      saveConfig();
    });
  }
  
  // Set and handle check updates toggle
  const checkUpdatesToggle = document.getElementById('check-updates-toggle');
  if (checkUpdatesToggle) {
    checkUpdatesToggle.checked = appConfig.checkForUpdates !== false;
    checkUpdatesToggle.addEventListener('change', (e) => {
      appConfig.checkForUpdates = e.target.checked;
      saveConfig();
      if (e.target.checked) {
        checkForUpdates(); // Check immediately when enabled
      }
    });
  }
}

function closeSettingsModal() {
  const modal = document.querySelector('.settings-modal');
  if (modal) {
    modal.remove();
  }
}

// Startup management functions
async function loadStartupToggleState() {
  try {
    const isEnabled = await ipcRenderer.invoke('get-startup-status');
    const toggle = document.getElementById('startup-toggle');
    if (toggle) {
      toggle.checked = !!isEnabled;
    }
  } catch (error) {
    console.error('Error loading startup state:', error);
  }
}

async function handleStartupToggle(event) {
  try {
    const enabled = event.target.checked;
    const success = await ipcRenderer.invoke('set-startup-status', enabled);
    
    if (!success) {
      // Revert toggle if failed
      event.target.checked = !enabled;
      const { dialog, getCurrentWindow } = require('@electron/remote');
      dialog.showMessageBox(getCurrentWindow(), {
        type: 'error',
        message: 'Failed to update startup setting',
        detail: 'Unable to modify Windows startup settings. Please check permissions.'
      });
    }
  } catch (error) {
    console.error('Error setting startup status:', error);
    // Revert toggle if failed
    event.target.checked = !event.target.checked;
  }
}

function copyToClipboard(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  let text = '';
  
  if (note.title) {
    text += `${note.title}\n${'='.repeat(note.title.length)}\n\n`;
  }
  
  if (note.tags && note.tags.length > 0) {
    text += `Tags: ${note.tags.join(', ')}\n\n`;
  }
  
  switch (note.type) {
    case 'text':
      text += note.content || '';
      break;
    case 'code':
      text += `Code (${note.codeLanguage}):\n\n${note.codeContent || ''}`;
      break;
    case 'todo':
      text += 'Tasks:\n';
      if (note.todoItems) {
        note.todoItems.forEach(item => {
          text += `${item.completed ? '✓' : '□'} ${item.text}\n`;
        });
      }
      break;
    default:
      text += note.content || '';
  }
  
  navigator.clipboard.writeText(text).then(() => {
    // Show feedback
    const btn = document.querySelector('.export-modal button');
    if (btn) {
      const originalText = btn.textContent;
      btn.textContent = '✅ Copied!';
      setTimeout(() => {
        closeShareModal();
      }, 1000);
    }
  }).catch(err => {
    console.error('Failed to copy to clipboard:', err);
    alert('Failed to copy to clipboard');
  });
}

function exportAsPNG(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Handle different note types for PNG export
  switch (note.type) {
    case 'paint':
      exportPaintAsPNG(note);
      break;
    case 'image':
      exportImageAsPNG(note);
      break;
    case 'table':
      exportTableAsPNG(note);
      break;
    default:
      alert('PNG export is not available for this note type.');
  }
}

function exportPaintAsPNG(note) {
  if (!note.paintData) {
    alert('No drawing data found to export.');
    return;
  }
  
  try {
    // Create download link from paint data
    const link = document.createElement('a');
    link.download = `${(note.title || 'drawing').replace(/[^a-zA-Z0-9]/g, '_')}_drawing.png`;
    link.href = note.paintData;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    closeShareModal();
  } catch (error) {
    console.error('Error exporting paint as PNG:', error);
    alert('Failed to export drawing as PNG.');
  }
}

function exportImageAsPNG(note) {
  if (!note.imagePath) {
    alert('No image data found to export.');
    return;
  }
  
  try {
    // Create download link from image data
    const link = document.createElement('a');
    link.download = `${(note.title || 'image').replace(/[^a-zA-Z0-9]/g, '_')}_image.png`;
    link.href = note.imagePath;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    closeShareModal();
  } catch (error) {
    console.error('Error exporting image as PNG:', error);
    alert('Failed to export image as PNG.');
  }
}

function exportTableAsPNG(note) {
  const noteElement = document.getElementById(note.id);
  if (!noteElement) {
    alert('Note element not found.');
    return;
  }
  
  // Create a canvas to render the table
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  // Set canvas size
  const rect = noteElement.getBoundingClientRect();
  canvas.width = rect.width * 2; // Higher resolution
  canvas.height = rect.height * 2;
  ctx.scale(2, 2);
  
  // Fill white background
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, rect.width, rect.height);
  
  // Draw note content (simplified version)
  ctx.fillStyle = '#333';
  ctx.font = '14px Arial';
  
  let y = 30;
  if (note.title) {
    ctx.font = 'bold 16px Arial';
    ctx.fillText(note.title, 10, y);
    y += 30;
  }
  
  ctx.font = '14px Arial';
  if (note.tableData && note.tableData.length > 0) {
    note.tableData.forEach((row, i) => {
      const rowText = row.join(' | ');
      ctx.fillText(`${i + 1}. ${rowText}`, 10, y);
      y += 20;
    });
  }
  
  // Download the canvas as PNG
  try {
    const link = document.createElement('a');
    link.download = `${(note.title || 'table').replace(/[^a-zA-Z0-9]/g, '_')}_table.png`;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    closeShareModal();
  } catch (error) {
    console.error('Error exporting table as PNG:', error);
    alert('Failed to export table as PNG.');
  }
}

// Sharing functionality
function createShareableFile(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Create a standalone HTML file with the note
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${note.title || 'PhasePad Note'}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: #f8f9fa;
        }
        .note-container {
            background: white;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .note-title {
            font-size: 28px;
            font-weight: 600;
            margin: 0 0 20px 0;
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        .note-meta {
            color: #7f8c8d;
            font-size: 14px;
            margin-bottom: 20px;
        }
        .note-tags {
            margin-bottom: 20px;
        }
        .tag {
            background: #3498db;
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            margin-right: 8px;
        }
        .note-content {
            white-space: pre-wrap;
            line-height: 1.7;
            color: #2c3e50;
        }
        .code-content {
            background: #f1f2f6;
            padding: 20px;
            border-radius: 8px;
            border-left: 4px solid #3498db;
            font-family: 'Courier New', monospace;
        }
        .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #eee;
            color: #95a5a6;
            font-size: 12px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div class="note-container">
        ${note.title ? `<h1 class="note-title">${note.title}</h1>` : ''}
        <div class="note-meta">
            Created: ${note.createdAt ? new Date(note.createdAt).toLocaleString() : 'Unknown'}
            ${note.tags && note.tags.length > 0 ? ` • ${note.tags.length} tag${note.tags.length > 1 ? 's' : ''}` : ''}
        </div>
        ${note.tags && note.tags.length > 0 ? `
            <div class="note-tags">
                ${note.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}
            </div>
        ` : ''}
        <div class="note-content ${note.type === 'code' ? 'code-content' : ''}">
            ${getFormattedContent(note)}
        </div>
        <div class="footer">
            Shared from PhasePad • <a href="#" onclick="alert('PhasePad is a desktop notes app')">Get PhasePad</a>
        </div>
    </div>
</body>
</html>`;
  
  // Create and download the file
  const blob = new Blob([htmlContent], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(note.title || 'note').replace(/[^a-zA-Z0-9]/g, '_')}_shareable.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  alert('Shareable HTML file created! You can send this file to anyone and they can open it in any web browser.');
  closeShareModal();
}

function generateShareText(noteId) {
  const note = notes.find(n => n.id === noteId);
  if (!note) return;
  
  // Generate shareable text format
  let shareText = '';
  
  if (note.title) {
    shareText += `${note.title}\n${'='.repeat(note.title.length)}\n\n`;
  }
  
  shareText += getPlainTextContent(note);
  
  if (note.tags && note.tags.length > 0) {
    shareText += `\n\nTags: ${note.tags.join(', ')}`;
  }
  
  shareText += `\n\n---\nCreated: ${note.createdAt ? new Date(note.createdAt).toLocaleString() : 'Unknown'}`;
  shareText += `\nShared from PhasePad`;
  
  // Copy to clipboard
  navigator.clipboard.writeText(shareText).then(() => {
    alert('Share text copied to clipboard! You can now paste this in messaging apps, social media, or anywhere you want to share your note.');
    closeShareModal();
  }).catch(err => {
    console.error('Failed to copy share text:', err);
    // Fallback: create a text file
    const blob = new Blob([shareText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(note.title || 'note').replace(/[^a-zA-Z0-9]/g, '_')}_share.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    alert('Share text saved as file! You can copy the contents to share.');
    closeShareModal();
  });
}

function getFormattedContent(note) {
  switch (note.type) {
    case 'text':
      return (note.content || '').replace(/\n/g, '<br>');
    case 'code':
      return `<strong>Language:</strong> ${note.codeLanguage || 'Plain text'}<br><br>${(note.codeContent || '').replace(/\n/g, '<br>')}`;
    case 'todo':
      if (note.todoItems) {
        return note.todoItems.map(item => 
          `${item.completed ? '✅' : '☐'} ${item.text}`
        ).join('<br>');
      }
      return 'No tasks';
    case 'web':
      return `<strong>URL:</strong> <a href="${note.url}" target="_blank">${note.url}</a><br><br>${(note.content || '').replace(/\n/g, '<br>')}`;
    case 'location':
      let locContent = '';
      if (note.locationName) locContent += `<strong>Location:</strong> ${note.locationName}<br>`;
      if (note.locationAddress) locContent += `<strong>Address:</strong> ${note.locationAddress}<br>`;
      if (note.content) locContent += `<br>${note.content.replace(/\n/g, '<br>')}`;
      return locContent;
    case 'reminder':
      let remContent = (note.content || '').replace(/\n/g, '<br>');
      if (note.reminderDate) {
        remContent += `<br><br><strong>Reminder:</strong> ${new Date(note.reminderDate).toLocaleString()}`;
      }
      return remContent;
    default:
      return (note.content || '').replace(/\n/g, '<br>');
  }
}

function getPlainTextContent(note) {
  switch (note.type) {
    case 'text':
      return note.content || '';
    case 'code':
      return `Code (${note.codeLanguage || 'Plain text'}):\n\n${note.codeContent || ''}`;
    case 'todo':
      if (note.todoItems) {
        return note.todoItems.map(item => 
          `${item.completed ? '[x]' : '[ ]'} ${item.text}`
        ).join('\n');
      }
      return 'No tasks';
    case 'web':
      return `Website: ${note.url || ''}\n\n${note.content || ''}`;
    case 'location':
      let locContent = '';
      if (note.locationName) locContent += `Location: ${note.locationName}\n`;
      if (note.locationAddress) locContent += `Address: ${note.locationAddress}\n`;
      if (note.content) locContent += `\n${note.content}`;
      return locContent;
    case 'reminder':
      let remContent = note.content || '';
      if (note.reminderDate) {
        remContent += `\n\nReminder: ${new Date(note.reminderDate).toLocaleString()}`;
      }
      return remContent;
    default:
      return note.content || '';
  }
}

// Import functionality
function showImportOptions() {
  // Create import modal
  const existingModal = document.querySelector('.import-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.className = 'import-modal';
  modal.innerHTML = `
    <div class="import-modal-content">
      <h3>Import Notes</h3>
      <p>Import notes from backup files</p>
      <div class="import-options">
        <button class="import-btn" onclick="importFromJSON()">
          📋 Import JSON Notes
        </button>
        <button class="import-btn" onclick="exportAllAsJSON()">
          💾 Export All Notes (Backup)
        </button>
        <button class="import-btn" onclick="importFromMarkdown()">
          📝 Import Markdown Files
        </button>
      </div>
      <div class="import-info">
        <small>Importing will add notes to your existing collection. Duplicate IDs will be skipped.</small>
      </div>
      <button class="import-close" onclick="closeImportModal()">Close</button>
    </div>
    <div class="import-modal-backdrop" onclick="closeImportModal()"></div>
  `;
  
  document.body.appendChild(modal);
}

function closeImportModal() {
  const modal = document.querySelector('.import-modal');
  if (modal) {
    modal.remove();
  }
}

function importFromJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.multiple = true;
  
  input.onchange = (e) => {
    const files = Array.from(e.target.files);
    let importedCount = 0;
    let skippedCount = 0;
    
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const noteData = JSON.parse(e.target.result);
          
          // Check if it's a backup file or single/multiple notes
          let notesToImport = [];
          if (noteData.notes && Array.isArray(noteData.notes)) {
            // It's a full backup file
            notesToImport = noteData.notes;
            if (noteData.archivedNotes && noteData.archivedNotes.length > 0) {
              // Also import archived notes
              archivedNotes.push(...noteData.archivedNotes.filter(n => !archivedNotes.find(existing => existing.id === n.id)));
            }
          } else if (Array.isArray(noteData)) {
            // It's an array of notes
            notesToImport = noteData;
          } else {
            // It's a single note
            notesToImport = [noteData];
          }
          
          notesToImport.forEach(note => {
            // Check if note already exists
            const existingNote = notes.find(n => n.id === note.id);
            if (existingNote) {
              skippedCount++;
              return;
            }
            
            // Validate and add note
            if (note.id && note.type) {
              // Generate new ID if needed to avoid conflicts
              note.id = note.id || generateId();
              note.x = note.x || Math.random() * 400;
              note.y = note.y || Math.random() * 400;
              note.width = note.width || 200;
              note.height = note.height || 150;
              note.color = note.color || noteColors[0];
              note.createdAt = note.createdAt || new Date().toISOString();
              
              notes.unshift(note);
              importedCount++;
            }
          });
          
          // Update display and save
          saveNotes();
          
          // Render newly imported notes
          notesToImport.forEach(note => {
            renderNote(note);
          });
          
          // Show result
          alert(`Import complete!\nImported: ${importedCount} notes\nSkipped: ${skippedCount} duplicates`);
          closeImportModal();
          
        } catch (error) {
          console.error('Error importing JSON:', error);
          alert(`Error importing file: ${error.message}\n\nPlease check that it's a valid JSON backup file exported from PhasePad.`);
        }
      };
      reader.readAsText(file);
    });
  };
  
  input.click();
}

function exportAllAsJSON() {
  const exportData = {
    notes: notes,
    archivedNotes: archivedNotes,
    exportedAt: new Date().toISOString(),
    version: '1.0'
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `phasepad_backup_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  // Show feedback
  alert('Backup created! This file contains all your notes and can be imported later.');
  closeImportModal();
}

function importFromMarkdown() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.txt';
  input.multiple = true;
  
  input.onchange = (e) => {
    const files = Array.from(e.target.files);
    let importedCount = 0;
    
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target.result;
        const fileName = file.name.replace(/\.(md|markdown|txt)$/, '');
        
        // Create a new text note from the markdown content
        const newNote = {
          id: generateId(),
          type: 'text',
          title: fileName,
          content: content,
          x: Math.random() * 400,
          y: Math.random() * 400,
          width: 250,
          height: 200,
          color: noteColors[0],
          tags: [],
          createdAt: new Date().toISOString()
        };
        
        notes.unshift(newNote);
        importedCount++;
        
        // Update display and save
        saveNotes();
        
        // Render newly imported note
        renderNote(newNote);
      };
      reader.readAsText(file);
    });
    
    // Show result after a short delay to ensure all files are processed
    setTimeout(() => {
      alert(`Imported ${importedCount} markdown files as text notes.`);
      closeImportModal();
    }, 500);
  };
  
  input.click();
}

// Folder item drag functionality
let draggedFolderItem = null;
let sourceFolder = null;

function startFolderItemDrag(event, itemId, folderId) {
  // Prevent the click event from firing
  event.stopPropagation();
  draggedFolderItem = itemId;
  sourceFolder = folderId;
}

function handleFolderItemDragStart(event, itemId, folderId) {
  event.stopPropagation();
  draggedFolderItem = itemId;
  sourceFolder = folderId;
  event.dataTransfer.setData("text/plain", itemId);
  event.dataTransfer.effectAllowed = "move";
  event.target.style.opacity = "0.5";
}

function handleFolderItemDragEnd(event) {
  event.target.style.opacity = "1";
  
  // Check if dragged outside any folder (remove from folder)
  setTimeout(() => {
    const rect = event.target.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Check if dropped outside all folder drop zones
    const elementBelow = document.elementFromPoint(centerX, centerY);
    const droppedOnFolder = elementBelow && elementBelow.closest('.folder-drop-zone');
    
    if (!droppedOnFolder && draggedFolderItem && sourceFolder) {
      // Remove from source folder and show on main canvas
      removeNoteFromFolder(null, sourceFolder, draggedFolderItem);
    }
    
    draggedFolderItem = null;
    sourceFolder = null;
  }, 100);
}

// Search functionality
let currentSearchQuery = '';
let searchFilters = {
  archived: false,
  content: true,
  titles: true,
  tags: true
};

function setupSearchFunctionality() {
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  const searchOptions = document.getElementById('search-options');
  const searchDropdown = document.getElementById('search-dropdown');
  const searchResults = document.getElementById('search-results');
  
  // Search input handling
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value;
    currentSearchQuery = query;
    
    if (query.trim()) {
      searchClear.style.display = 'flex';
      performSearch(query);
    } else {
      searchClear.style.display = 'none';
      hideSearchResults();
      clearNoteHighlights();
    }
  });
  
  // Clear search
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    currentSearchQuery = '';
    hideSearchResults();
    clearNoteHighlights();
    searchInput.focus();
  });
  
  // Search options toggle
  searchOptions.addEventListener('click', (e) => {
    e.stopPropagation();
    searchDropdown.classList.toggle('active');
  });
  
  // Search filter changes
  document.getElementById('search-archived').addEventListener('change', (e) => {
    searchFilters.archived = e.target.checked;
    if (currentSearchQuery.trim()) {
      performSearch(currentSearchQuery);
    }
  });
  
  document.getElementById('search-content').addEventListener('change', (e) => {
    searchFilters.content = e.target.checked;
    if (currentSearchQuery.trim()) {
      performSearch(currentSearchQuery);
    }
  });
  
  document.getElementById('search-titles').addEventListener('change', (e) => {
    searchFilters.titles = e.target.checked;
    if (currentSearchQuery.trim()) {
      performSearch(currentSearchQuery);
    }
  });
  
  document.getElementById('search-tags').addEventListener('change', (e) => {
    searchFilters.tags = e.target.checked;
    if (currentSearchQuery.trim()) {
      performSearch(currentSearchQuery);
    }
  });
  
  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      searchDropdown.classList.remove('active');
      if (!currentSearchQuery.trim()) {
        hideSearchResults();
      }
    }
  });
}

function performSearch(query) {
  const results = [];
  const queryLower = query.toLowerCase();
  
  // Search active notes
  notes.forEach(note => {
    const match = searchNote(note, queryLower, false);
    if (match) {
      results.push(match);
    }
  });
  
  // Search archived notes if enabled
  if (searchFilters.archived) {
    archivedNotes.forEach(note => {
      const match = searchNote(note, queryLower, true);
      if (match) {
        results.push(match);
      }
    });
  }
  
  displaySearchResults(results, query);
  highlightNotesInView(results.filter(r => !r.archived));
}

function searchNote(note, queryLower, isArchived) {
  let titleMatch = false;
  let contentMatch = false;
  let tagsMatch = false;
  let matchedContent = '';
  
  // Search title
  if (searchFilters.titles && note.title && note.title.toLowerCase().includes(queryLower)) {
    titleMatch = true;
  }
  
  // Search tags
  if (searchFilters.tags && note.tags && note.tags.length > 0) {
    const tagString = note.tags.join(' ').toLowerCase();
    if (tagString.includes(queryLower)) {
      tagsMatch = true;
    }
  }
  
  // Search content based on note type
  if (searchFilters.content) {
    let searchableContent = '';
    
    switch (note.type) {
      case 'text':
        searchableContent = note.content || '';
        break;
      case 'web':
        searchableContent = `${note.webUrl || ''} ${note.webTitle || ''} ${note.webDescription || ''}`;
        break;
      case 'location':
        searchableContent = `${note.locationName || ''} ${note.locationAddress || ''} ${note.locationNotes || ''}`;
        break;
      case 'reminder':
        searchableContent = note.reminderMessage || '';
        break;
      case 'todo':
        searchableContent = note.todoItems ? note.todoItems.map(item => item.text).join(' ') : '';
        break;
      case 'table':
        searchableContent = note.tableData ? note.tableData.flat().join(' ') : '';
        break;
      case 'file':
        searchableContent = note.filePath || '';
        break;
      case 'code':
        searchableContent = note.codeContent || '';
        break;
      case 'folder':
        // Search folder item titles
        if (note.folderItems && note.folderItems.length > 0) {
          const folderItemTitles = note.folderItems.map(itemId => {
            const item = notes.find(n => n.id === itemId) || archivedNotes.find(n => n.id === itemId);
            return item ? (item.title || '') : '';
          }).filter(title => title.length > 0);
          searchableContent = folderItemTitles.join(' ');
        }
        break;
    }
    
    if (searchableContent.toLowerCase().includes(queryLower)) {
      contentMatch = true;
      // Extract context around the match
      const index = searchableContent.toLowerCase().indexOf(queryLower);
      const start = Math.max(0, index - 30);
      const end = Math.min(searchableContent.length, index + queryLower.length + 30);
      matchedContent = searchableContent.substring(start, end);
    }
  }
  
  if (titleMatch || contentMatch || tagsMatch) {
    return {
      note,
      titleMatch,
      contentMatch,
      tagsMatch,
      matchedContent,
      archived: isArchived
    };
  }
  
  return null;
}

function displaySearchResults(results, query) {
  const searchResults = document.getElementById('search-results');
  
  if (results.length === 0) {
    searchResults.innerHTML = '<div class="search-result"><div class="search-result-content">No results found</div></div>';
  } else {
    searchResults.innerHTML = results.map(result => {
      const { note, titleMatch, contentMatch, tagsMatch, matchedContent, archived } = result;
      const noteTypeInfo = getNoteTypeInfo(note.type);
      
      return `
        <div class="search-result" onclick="focusSearchResult('${note.id}', ${archived})">
          <div class="search-result-title">
            <span>${noteTypeInfo.icon}</span>
            <span>${highlightText(note.title || 'Untitled', query)}</span>
            <span class="search-result-type">${noteTypeInfo.name}</span>
            ${archived ? '<span class="search-result-archived">Archived</span>' : ''}
          </div>
          ${tagsMatch && note.tags && note.tags.length > 0 ? `<div class="search-result-tags">${note.tags.map(tag => `<span class="search-result-tag">${highlightText(tag, query)}</span>`).join('')}</div>` : ''}
          ${contentMatch ? `<div class="search-result-content">${highlightText(matchedContent, query)}</div>` : ''}
        </div>
      `;
    }).join('');
  }
  
  searchResults.classList.add('active');
}

function highlightText(text, query) {
  if (!text) return '';
  const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
  return text.replace(regex, '<span class="search-highlight">$1</span>');
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNoteTypeInfo(type) {
  const types = {
    text: { icon: '📝', name: 'Text' },
    file: { icon: '📁', name: 'File' },
    image: { icon: '🖼️', name: 'Image' },
    paint: { icon: '🎨', name: 'Paint' },
    todo: { icon: '✅', name: 'Todo' },
    reminder: { icon: '⏰', name: 'Reminder' },
    web: { icon: '🌐', name: 'Web' },
    table: { icon: '📋', name: 'Table' },
    location: { icon: '📍', name: 'Location' },
    calculator: { icon: '🧮', name: 'Calculator' },
    timer: { icon: '⏲️', name: 'Timer' },
    folder: { icon: '📂', name: 'Folder' },
    code: { icon: '💻', name: 'Code' }
  };
  return types[type] || { icon: '📝', name: 'Note' };
}

function focusSearchResult(noteId, isArchived) {
  if (isArchived) {
    // Restore archived note first
    restoreNote(noteId);
    hideSearchResults();
    // Focus on the restored note after a brief delay
    setTimeout(() => {
      focusOnNote(noteId);
    }, 300);
  } else {
    focusOnNote(noteId);
    hideSearchResults();
  }
  
  // Clear search
  document.getElementById('search-input').value = '';
  document.getElementById('search-clear').style.display = 'none';
  currentSearchQuery = '';
  clearNoteHighlights();
}

function hideSearchResults() {
  document.getElementById('search-results').classList.remove('active');
}

function highlightNotesInView(results) {
  // Add visual highlight to matching notes in the overlay
  clearNoteHighlights();
  
  results.forEach(result => {
    const noteElement = document.getElementById(result.note.id);
    if (noteElement) {
      noteElement.style.outline = '2px solid #4a90e2';
      noteElement.style.boxShadow = '0 0 10px rgba(74, 144, 226, 0.5)';
    }
  });
}

function clearNoteHighlights() {
  notes.forEach(note => {
    const noteElement = document.getElementById(note.id);
    if (noteElement) {
      noteElement.style.outline = '';
      noteElement.style.boxShadow = '';
    }
  });
}

// Global functions for onclick handlers
window.deleteNote = deleteNote;
window.openFile = openFile;
window.selectFile = selectFile;
window.selectImage = selectImage;
window.showImageOptions = showImageOptions;
window.showScreenshotOptions = showScreenshotOptions;
window.captureScreenshot = captureScreenshot;
window.takeAreaScreenshot = takeAreaScreenshot;
window.clearCanvas = clearCanvas;
window.addTodo = addTodo;
window.deleteTodo = deleteTodo;
window.toggleTodo = toggleTodo;
window.updateTodoText = updateTodoText;
window.archiveNote = archiveNote;
window.restoreNote = restoreNote;
window.hideArchivePanel = hideArchivePanel;
window.updateReminderDateTime = updateReminderDateTime;
window.updateReminderMessage = updateReminderMessage;
window.resetReminder = resetReminder;
window.testReminder = testReminder;
window.updateWebUrl = updateWebUrl;
window.updateWebTitle = updateWebTitle;
window.updateWebDescription = updateWebDescription;
window.openWebUrl = openWebUrl;
window.copyWebUrl = copyWebUrl;
window.toggleWebPreview = toggleWebPreview;
window.updateTableCell = updateTableCell;
window.addTableRow = addTableRow;
window.addTableColumn = addTableColumn;
window.removeTableRow = removeTableRow;
window.removeTableColumn = removeTableColumn;
window.updateLocationName = updateLocationName;
window.updateLocationAddress = updateLocationAddress;
window.updateLocationNotes = updateLocationNotes;
window.openLocationMaps = openLocationMaps;
window.copyLocationAddress = copyLocationAddress;
window.calculatorInput = calculatorInput;
window.calculatorEquals = calculatorEquals;
window.calculatorClear = calculatorClear;
window.calculatorBackspace = calculatorBackspace;
window.setTimerPreset = setTimerPreset;
window.setCustomTimer = setCustomTimer;
window.toggleTimer = toggleTimer;
window.resetTimer = resetTimer;
window.detachTimer = detachTimer;

// Version comparison utility
function compareVersions(version1, version2) {
  // Remove 'v' prefix if present and normalize
  const v1 = version1.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  const v2 = version2.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  
  // Pad arrays to same length
  const maxLength = Math.max(v1.length, v2.length);
  while (v1.length < maxLength) v1.push(0);
  while (v2.length < maxLength) v2.push(0);
  
  // Compare each part
  for (let i = 0; i < maxLength; i++) {
    if (v1[i] < v2[i]) return -1;
    if (v1[i] > v2[i]) return 1;
  }
  return 0;
}

function isNewerVersion(currentVersion, latestVersion) {
  return compareVersions(currentVersion, latestVersion) < 0;
}

// Update checking functionality
async function checkForUpdates() {
  try {
    // First try using electron-updater through IPC
    const result = await ipcRenderer.invoke('check-for-updates');
    
    // Also check GitHub API for release notes
    const response = await fetch('https://api.github.com/repos/OwenModsTW/PhasePad/releases/latest');
    if (response.ok) {
      const latestRelease = await response.json();
      const currentVersion = 'v1.0.2'; // Update this with each release
      
      // Only show notification if the latest version is actually newer
      if (latestRelease.tag_name && isNewerVersion(currentVersion, latestRelease.tag_name)) {
        console.log(`Update available: ${currentVersion} -> ${latestRelease.tag_name}`);
        showUpdateNotification(latestRelease);
      } else {
        console.log(`No update needed. Current: ${currentVersion}, Latest: ${latestRelease.tag_name || 'unknown'}`);
      }
    }
  } catch (error) {
    console.error('Error checking for updates:', error);
  }
}

function showUpdateNotification(release) {
  // Remove any existing update notification
  const existingNotification = document.querySelector('.update-notification');
  if (existingNotification) {
    existingNotification.remove();
  }
  
  // Create update notification
  const notification = document.createElement('div');
  notification.className = 'update-notification';
  notification.innerHTML = `
    <button class="update-notification-close" onclick="this.parentElement.remove()">×</button>
    <h3>🎉 Update Available!</h3>
    <p><strong>${release.tag_name}</strong> - ${release.name || 'New version available'}</p>
    <div class="update-actions">
      <button class="update-btn-primary" onclick="require('electron').shell.openExternal('${release.html_url}')">Download Update</button>
      <button class="update-btn-secondary" onclick="this.parentElement.parentElement.remove()">Remind Me Later</button>
    </div>
  `;
  
  document.body.appendChild(notification);
  
  // Auto-hide after 15 seconds
  setTimeout(() => {
    if (notification.parentElement) {
      notification.remove();
    }
  }, 15000);
}

window.checkForUpdates = checkForUpdates;
window.focusSearchResult = focusSearchResult;
window.showUpdateNotification = showUpdateNotification; // For testing
window.compareVersions = compareVersions; // For testing
window.isNewerVersion = isNewerVersion; // For testing


// Custom delete confirmation modal
function showDeleteConfirmation(note) {
  return new Promise((resolve) => {
    // Remove any existing confirmation modal
    const existingModal = document.querySelector('.delete-confirmation-modal');
    if (existingModal) {
      existingModal.remove();
    }
    
    const modal = document.createElement('div');
    modal.className = 'delete-confirmation-modal';
    modal.innerHTML = `
      <div class="delete-confirmation-backdrop" onclick="closeDeleteConfirmation(false)"></div>
      <div class="delete-confirmation-content">
        <div class="delete-confirmation-header">
          <h3>Delete Note?</h3>
        </div>
        <div class="delete-confirmation-body">
          <p>Are you sure you want to delete this <strong>${escapeHtml(note.type)}</strong> note?</p>
          ${note.title ? `<p class="delete-confirmation-title">"${escapeHtml(note.title)}"</p>` : ''}
          <p class="delete-confirmation-warning">This action cannot be undone.</p>
        </div>
        <div class="delete-confirmation-actions">
          <button class="delete-confirmation-btn cancel-btn" onclick="closeDeleteConfirmation(false)">Cancel</button>
          <button class="delete-confirmation-btn delete-btn" onclick="closeDeleteConfirmation(true)">Delete</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Store the resolve function globally so buttons can access it
    window._deleteConfirmationResolve = resolve;
    
    // Add keyboard event listener
    const handleKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDeleteConfirmation(false);
        document.removeEventListener('keydown', handleKeydown);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        closeDeleteConfirmation(true);
        document.removeEventListener('keydown', handleKeydown);
      }
    };
    
    document.addEventListener('keydown', handleKeydown);
    
    // Focus the cancel button by default (safer)
    setTimeout(() => {
      const cancelBtn = modal.querySelector('.cancel-btn');
      if (cancelBtn) {
        cancelBtn.focus();
      }
    }, 100);
  });
}

function closeDeleteConfirmation(confirmed) {
  const modal = document.querySelector('.delete-confirmation-modal');
  if (modal) {
    modal.remove();
  }
  
  if (window._deleteConfirmationResolve) {
    window._deleteConfirmationResolve(confirmed);
    delete window._deleteConfirmationResolve;
  }
}

window.closeDeleteConfirmation = closeDeleteConfirmation;