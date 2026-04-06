import React, { useState, useRef, useEffect } from 'react';
import { 
  StyleSheet, Text, View, TouchableOpacity, Modal, ScrollView, Alert, 
  useWindowDimensions, Platform, TextInput, Switch, 
  TouchableWithoutFeedback, Share, Dimensions, BackHandler, Linking
} from 'react-native';
import { Stack } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Ionicons } from '@expo/vector-icons';
import * as NavigationBar from 'expo-navigation-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import PagerView from 'react-native-pager-view';
import LZString from 'lz-string';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// ==========================================
// ZONE 1: ENGINE, MATH & PURE FUNCTIONS
// ==========================================
const SCHEMA_VERSION = 2;

const CONFIG = {
  suits: ['♣', '♦', '♥', '♠', 'NT'],
  penalties: {
    notVul: [50], 
    notVulX: [100, 300, 500, 800, 1100, 1400, 1700, 2000, 2300, 2600],
    vul: [100], 
    vulX: [200, 500, 800, 1100, 1400, 1700, 2000, 2300, 2600, 2900]
  }
};

const DATE_CONFIG = {
  useMonthName: true,
  use12Hour: false,
  padHour: false
};

const ScoringEngine = {
  calcTrickBase: (suit, level) => suit === 'NT' ? 40 + (level - 1) * 30 : (suit === '♥' || suit === '♠') ? level * 30 : level * 20,

  generateResultOptions: (bidLevel) => {
    if (!bidLevel) return [];
    let options = []; const req = bidLevel + 6;
    for (let d = req; d >= 1; d--) options.push(`down ${d}`);
    options.push('made it');
    for (let o = 1; o <= (13 - req); o++) options.push(`${o} over`);
    return options;
  },

  calculateHandScore: (side, bidLevel, bidSuit, multiplier, honors, contractResult, ledger) => {
    const isVul = (ledger[side].games > 0); 
    const bidStr = `${bidLevel}${bidSuit}`;
    let newLogs = [];

    if (contractResult.includes("down")) {
      const oppSide = (side === 'we' ? 'they' : 'we');
      const downCount = parseInt(contractResult.match(/\d+/)[0]);
      let pts = multiplier === 'n' ? downCount * (isVul ? 100 : 50) : (isVul ? CONFIG.penalties.vulX : CONFIG.penalties.notVulX)[downCount - 1] * (multiplier === 'xx' ? 2 : 1);
      newLogs.push({ s: oppSide, t: 'down', section: 'above', sc: pts, anno: `${bidStr}${multiplier==='x'?'x':multiplier==='xx'?'xx':''} ${contractResult}` });
    } else {
      let trickPoints = ScoringEngine.calcTrickBase(bidSuit, bidLevel) * (multiplier === 'x' ? 2 : multiplier === 'xx' ? 4 : 1);
      const isGameWon = (ledger[side].partial + trickPoints >= 100);
      newLogs.push({ s: side, t: 'made', section: 'below', sc: trickPoints, g: isGameWon, anno: `${bidStr}${multiplier==='x'?'x':multiplier==='xx'?'xx':''}` });
      
      if (contractResult.includes("over")) {
        const ot = parseInt(contractResult.match(/\d+/)[0]); 
        let otPts = multiplier === 'n' ? ot * ((bidSuit==='♣'||bidSuit==='♦') ? 20 : 30) : ot * (isVul ? 200 : 100) * (multiplier === 'xx' ? 2 : 1);
        if(otPts > 0) newLogs.push({ s: side, t: 'ot', section: 'above', sc: otPts, anno: `${ot} over` });
      }
      
      let slamPts = 0;
      if (bidLevel === 6) slamPts = (isVul ? 750 : 500);
      if (bidLevel === 7) slamPts = (isVul ? 1500 : 1000);
      if (slamPts > 0) newLogs.push({ s: side, t: 'slam', section: 'above', sc: slamPts, anno: `${bidLevel===6?'small':'grand'} slam` });
      
      if (honors > 0) newLogs.push({ s: side, t: 'hon', section: 'above', sc: honors, anno: `${honors} honors` });
      if (multiplier === 'x') newLogs.push({ s: side, t: 'ins', section: 'above', sc: 50, anno: 'insult' });
      if (multiplier === 'xx') newLogs.push({ s: side, t: 'ins', section: 'above', sc: 100, anno: 'insult' });
    }
    return newLogs;
  },

  calculateUnfinishedBonus: (ledger, currentHands) => {
    let hands = [...currentHands];
    let weB = 0; let theyB = 0;
    if (ledger.we.games === 1 && ledger.they.games === 0) weB += 300; 
    else if (ledger.they.games === 1 && ledger.we.games === 0) theyB += 300;
    if (ledger.we.partial > 0 && ledger.they.partial === 0) weB += 100; 
    else if (ledger.they.partial > 0 && ledger.we.partial === 0) theyB += 100;
    if (weB > 0) hands.push({ s: 'we', t: 'rub', section: 'above', sc: weB, anno: 'unfinished bonus' });
    if (theyB > 0) hands.push({ s: 'they', t: 'rub', section: 'above', sc: theyB, anno: 'unfinished bonus' });
    return hands;
  },

  unpackLog: (packedLog) => {
    const revSide = ["we", "they"];
    const revType = ["made", "down", "ot", "hon", "ins", "slam", "rub"];
    const revMult = ["n", "x", "xx"];

    return packedLog.map(arr => {
      let obj = { s: revSide[arr[0]], t: revType[arr[1]], sc: arr[2] };
      let bidStr = '', mult = 'n';

      if (obj.t === 'made' || obj.t === 'down') {
        bidStr = arr[3] || '';
        mult = revMult[arr[4]] || 'n';
        obj.b = bidStr;
        obj.m = mult;
      }

      const suff = mult === 'x' ? 'x' : mult === 'xx' ? 'xx' : '';
      const fullBid = `${bidStr}${suff}`;

      if (obj.t === 'made') {
        obj.g = (arr[5] === 1);
        obj.section = 'below';
        obj.anno = fullBid;
      } else if (obj.t === 'down') {
        obj.lbl = arr[5];
        obj.section = 'above';
        obj.anno = `${fullBid} ${obj.lbl}`.trim();
      } else if (obj.t === 'ot') {
        obj.cnt = arr[3];
        obj.section = 'above';
        obj.anno = `${obj.cnt} over`;
      } else if (obj.t === 'hon') {
        obj.section = 'above';
        obj.anno = `${obj.sc} honors`;
      } else if (obj.t === 'ins') {
        obj.section = 'above';
        obj.anno = 'insult';
      } else if (obj.t === 'slam') {
        obj.lvl = arr[3];
        obj.section = 'above';
        obj.anno = `${obj.lvl === 6 ? 'small' : 'grand'} slam`;
      } else if (obj.t === 'rub') {
        obj.section = 'above';
        obj.anno = 'rubber bonus'; 
      }
      return obj;
    });
  },

  recalcLedger: (logs) => {
    let m = { we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } };
    logs.forEach(l => {
      if (l.t === 'made') {
        if (l.g) { m[l.s].games++; m.we.partial = 0; m.they.partial = 0; }
        else { m[l.s].partial += l.sc; }
      }
    });
    return m;
  }
};

// ==========================================
// ZONE 2: UTILITIES & HELPERS
// ==========================================
const btoa = (str) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let output = '';
  for (let block = 0, charCode, i = 0, map = chars; str.charAt(i | 0) || (map = '=', i % 1); output += map.charAt(63 & block >> 8 - i % 1 * 8)) {
    charCode = str.charCodeAt(i += 3 / 4);
    block = block << 8 | charCode;
  }
  return output;
};

const atob = (str) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  let output = '';
  str = String(str).replace(/=+$/, '');
  for (let bc = 0, bs, buffer, idx = 0; buffer = str.charAt(idx++); ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer, bc++ % 4) ? output += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
    buffer = chars.indexOf(buffer);
  }
  return output;
};

const sanitize = (str) => {
  if (typeof str !== 'string') return str;
  return str.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

const getFormattedDate = () => {
  const d = new Date();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  const year = d.getFullYear();
  const month = DATE_CONFIG.useMonthName ? monthNames[d.getMonth()] : String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  
  let hoursNum = d.getHours();
  const ampm = hoursNum >= 12 ? 'PM' : 'AM';
  
  if (DATE_CONFIG.use12Hour) hoursNum = hoursNum % 12 || 12;
  
  const hoursStr = DATE_CONFIG.padHour ? String(hoursNum).padStart(2, '0') : String(hoursNum);
  const minutes = String(d.getMinutes()).padStart(2, '0');
  
  const timeStr = DATE_CONFIG.use12Hour ? `${hoursStr}:${minutes} ${ampm}` : `${hoursStr}:${minutes}`;
  return `${year}-${month}-${day} ${timeStr}`;
};

const safeConfirm = (title, message, onConfirm, onCancel) => {
  if (Platform.OS === 'web') {
    if (window.confirm(`${title}\n${message}`)) {
        onConfirm();
    } else if (onCancel) {
        onCancel();
    }
  } else {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: onCancel },
      { text: "Confirm", style: "destructive", onPress: onConfirm }
    ]);
  }
};

const BaseModal = ({ visible, onClose, title, children, insets }) => (
  <Modal visible={visible} animationType="fade" transparent={true} onRequestClose={onClose}>
    <TouchableWithoutFeedback onPress={onClose}>
      <View style={styles.modalOverlayCentered}>
        <TouchableWithoutFeedback>
          <View style={[styles.modalContent, { paddingBottom: insets.bottom || 40 }]} accessible={true} accessibilityRole="alert">
            <Text style={styles.modalTitle} accessibilityRole="header">{title}</Text>
            {children}
            <TouchableOpacity style={styles.modalCloseBtn} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close popup">
              <Text style={styles.closeText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableWithoutFeedback>
      </View>
    </TouchableWithoutFeedback>
  </Modal>
);

// ==========================================
// ZONE 3: STATE MANAGEMENT (APP WRAPPER)
// ==========================================
export default function App() {
  return (
    <SafeAreaProvider>
      <MainContent />
    </SafeAreaProvider>
  );
}

function MainContent() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isTablet = width > 800;

  const [activeTab, setActiveTab] = useState(0);
  const pagerRef = useRef(null);
  const modalScrollRef = useRef(null);

  const [isLoaded, setIsLoaded] = useState(false);
  const [settings, setSettings] = useState({ 
    fourColor: false, showHonors: true, showRecentPlayers: true, 
    keepAwake: true, haptics: false 
  });
  
  const [names, setNames] = useState({ we1: '', we2: '', they1: '', they2: '' });
  const [focusedInput, setFocusedInput] = useState('we1');
  const [allNames, setAllNames] = useState([]);
  const [players, setPlayers] = useState({});
  const [rubberNum, setRubberNum] = useState(1);
  const [hands, setHands] = useState([]);
  const [ledger, setLedger] = useState({ we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } });
  
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [archive, setArchive] = useState([]);
  const [historyVault, setHistoryVault] = useState([]);
  const [history, setHistory] = useState([]);

  const [side, setSide] = useState(null);
  const [bidLevel, setBidLevel] = useState(null);
  const [bidSuit, setBidSuit] = useState(null);
  const [multiplier, setMultiplier] = useState('n');
  const [honors, setHonors] = useState(0);
  const [contractResult, setContractResult] = useState('made it');

  const [rubberCompleteStatus, setRubberCompleteStatus] = useState(null);
  const [isReviewingScorecard, setIsReviewingScorecard] = useState(false); 

  const [sessionFoundModalVisible, setSessionFoundModalVisible] = useState(false);
  const [sessionFoundData, setSessionFoundData] = useState(null);
  const [resultModalVisible, setResultModalVisible] = useState(false);
  const [menuModalVisible, setMenuModalVisible] = useState(false);
  const [playerModalVisible, setPlayerModalVisible] = useState(false);
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [historyModalVisible, setHistoryModalVisible] = useState(false);
  const [aboutModalVisible, setAboutModalVisible] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  
  const [selectedVaultSession, setSelectedVaultSession] = useState(null);
  const [renameText, setRenameText] = useState('');
  
  const [pendingShareUrl, setPendingShareUrl] = useState(null);

  useEffect(() => {
    const backAction = () => {
      if (selectedVaultSession) { setSelectedVaultSession(null); return true; }
      return false;
    };
    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [selectedVaultSession]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      NavigationBar.setButtonStyleAsync("light").catch(() => {});
    }
  }, []);

  const saveActiveSessionImmediate = async (overrides = {}) => {
    const dataToSave = {
      schemaVersion: SCHEMA_VERSION,
      settings: overrides.settings || settings,
      names: overrides.names || names,
      allNames: overrides.allNames || allNames,
      players: overrides.players || players,
      rubberNum: overrides.rubberNum || rubberNum,
      hands: overrides.hands || hands,
      ledger: overrides.ledger || ledger,
      archive: overrides.archive || archive,
      historyVault: overrides.historyVault || historyVault,
      history: overrides.history || history,
      sessionStartTime: overrides.sessionStartTime || sessionStartTime,
      rubberCompleteStatus: overrides.rubberCompleteStatus !== undefined ? overrides.rubberCompleteStatus : rubberCompleteStatus
    };
    try {
        await AsyncStorage.setItem('RubberSoulState', JSON.stringify(dataToSave));
    } catch (e) {
        console.error("Immediate save failed:", e);
    }
  };

  useEffect(() => {
    const loadState = async () => {
      try {
        const saved = await AsyncStorage.getItem('RubberSoulState');
        if (saved) {
          let parsed = JSON.parse(saved);
          
          if (!parsed.schemaVersion || parsed.schemaVersion < SCHEMA_VERSION) {
            parsed.schemaVersion = SCHEMA_VERSION;
            parsed.historyVault = parsed.historyVault || [];
          }

          setSettings(parsed.settings || { fourColor: false, showHonors: true, showRecentPlayers: true, keepAwake: true, haptics: false });
          setAllNames(parsed.allNames || []); setPlayers(parsed.players || {});
          setHistoryVault(parsed.historyVault || []); setSessionStartTime(parsed.sessionStartTime || getFormattedDate());
          setRubberCompleteStatus(parsed.rubberCompleteStatus || null);

          if (parsed.names?.we1 || parsed.archive?.length > 0 || parsed.hands?.length > 0) {
            setNames(parsed.names); setRubberNum(parsed.rubberNum); setHands(parsed.hands);
            setLedger(parsed.ledger); setArchive(parsed.archive); setHistory(parsed.history || []);
            setSessionFoundData(parsed); setSessionFoundModalVisible(true);
          } else {
            setPlayerModalVisible(true);
          }
        } else {
          setSessionStartTime(getFormattedDate()); setPlayerModalVisible(true);
        }
      } catch (e) { console.error(e); }
      setIsLoaded(true);
    };
    loadState();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    const writeTimer = setTimeout(() => {
      AsyncStorage.setItem('RubberSoulState', JSON.stringify({ 
        schemaVersion: SCHEMA_VERSION, settings, names, allNames, players, rubberNum, hands, ledger, archive, historyVault, history, sessionStartTime, rubberCompleteStatus 
      })).catch(e => console.error(e));
    }, 500);
    return () => clearTimeout(writeTimer);
  }, [settings, names, allNames, players, rubberNum, hands, ledger, archive, historyVault, history, sessionStartTime, rubberCompleteStatus, isLoaded]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (settings.keepAwake) activateKeepAwakeAsync().catch(() => {});
    else deactivateKeepAwake().catch(() => {});
  }, [settings.keepAwake]);

  useEffect(() => {
    if (resultModalVisible && modalScrollRef.current && bidLevel) {
       const madeItIndex = bidLevel + 6;
       setTimeout(() => modalScrollRef.current?.scrollTo({ y: (madeItIndex * 50) - 120, animated: false }), 50);
    }
  }, [resultModalVisible, bidLevel]);

  useEffect(() => {
    const handleUrl = ({ url }) => { if (url && url.includes('#')) setPendingShareUrl(url); };
    Linking.getInitialURL().then(url => { if (url) handleUrl({ url }); });
    const sub = Linking.addEventListener('url', handleUrl);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (pendingShareUrl && isLoaded) {
      const url = pendingShareUrl;

      try {
        const hashStr = url.split('#')[1];
        if (!hashStr) throw new Error("No hash payload found");
        
        let decoded;
        try {
            const decompressed = LZString.decompressFromEncodedURIComponent(hashStr);
            if (!decompressed) throw new Error("LZ decompression failed");
            decoded = JSON.parse(decompressed);
        } catch (e) {
            decoded = JSON.parse(decodeURIComponent(escape(atob(hashStr))));
        }

        if (Array.isArray(decoded) && (decoded[0] === 4 || decoded[0] === 5)) {
          safeConfirm("Import Session", "Loading this shared link will pause your current session and save it to History. Proceed?", () => {

            let newVault = [...historyVault];
            if (names.we1 || hands.length > 0 || archive.length > 0) {
              let stArchive = [...archive];
              if (hands.length > 0) {
                const h = ScoringEngine.calculateUnfinishedBonus(ledger, hands);
                const wT = h.filter(l => l.s === 'we').reduce((a, b) => a + b.sc, 0);
                const tT = h.filter(l => l.s === 'they').reduce((a, b) => a + b.sc, 0);
                stArchive.unshift({ num: rubberNum, names: names, weTotal: wT, theyTotal: tT, hands: h });
              } else if (names.we1) {
                // Save stub scorecard if names exist but no hands played
                stArchive.unshift({ num: rubberNum, names: names, weTotal: 0, theyTotal: 0, hands: [] });
              }
              
              if (stArchive.length > 0) {
                newVault.unshift({ id: Date.now(), date: sessionStartTime || getFormattedDate(), name: null, players: players, archive: stArchive });
              }
            }

            const importedNames = { we1: decoded[1][0], we2: decoded[1][1], they1: decoded[1][2], they2: decoded[1][3] };
            let tally = {};
            const initP = (nArr) => { nArr.forEach(n => { if (n && !tally[n]) tally[n] = 0; }); };

            const importedArchive = decoded[2].map(a => {
              const aLogs = ScoringEngine.unpackLog(a.l);
              initP(a.n);
              const wT = aLogs.filter(l => l.s === 'we').reduce((acc, curr) => acc + curr.sc, 0);
              const tT = aLogs.filter(l => l.s === 'they').reduce((acc, curr) => acc + curr.sc, 0);
              const diff = Math.abs(wT - tT);
              if (wT > tT) { tally[a.n[0]] += diff; tally[a.n[1]] += diff; tally[a.n[2]] -= diff; tally[a.n[3]] -= diff; }
              else { tally[a.n[0]] -= diff; tally[a.n[1]] -= diff; tally[a.n[2]] += diff; tally[a.n[3]] += diff; }
              return { num: 0, names: { we1: a.n[0], we2: a.n[1], they1: a.n[2], they2: a.n[3] }, weTotal: wT, theyTotal: tT, hands: aLogs };
            });

            importedArchive.reverse().forEach((rub, idx) => rub.num = idx + 1);
            importedArchive.reverse();

            initP(decoded[1]);
            const importedHands = ScoringEngine.unpackLog(decoded[3]);
            const importedLedger = ScoringEngine.recalcLedger(importedHands);

            const newAllNames = [...allNames];
            Object.keys(tally).forEach(n => { if (!newAllNames.includes(n)) newAllNames.push(n); });

            setHistoryVault(newVault);
            setArchive(importedArchive);
            setHands(importedHands);
            setLedger(importedLedger);
            setNames(importedNames);
            setPlayers(tally);
            setRubberNum(importedArchive.length + 1);
            setSessionStartTime(getFormattedDate());
            setHistory([]);
            setRubberCompleteStatus(null);
            setIsReviewingScorecard(false);
            resetBiddingBox();
            setAllNames(newAllNames);
            setPendingShareUrl(null);

            jumpToTab(1); 
          }, () => {
              setPendingShareUrl(null);
          });
        }
      } catch (e) {
        setPendingShareUrl(null);
        Alert.alert("Error", "Could not load this session. The link might be invalid or corrupted.");
      }
    }
  }, [pendingShareUrl, isLoaded, names, archive, hands, players, rubberNum, ledger, historyVault, sessionStartTime, allNames]);

  const triggerHaptic = () => { if (settings.haptics) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); };

  const getSuitColor = (s) => {
    if (settings.fourColor) { if (s === '♦') return '#1E90FF'; if (s === '♣') return '#008000'; }
    return (s === '♥' || s === '♦') ? COLORS.inkCrimson : (s === '♣' || s === '♠') ? COLORS.inkCharcoal : '#333';
  };

  const jumpToTab = (index) => {
    if (isTablet) return;
    setActiveTab(index);
    pagerRef.current?.setPage(index);
  };

  // ==========================================
  // ZONE 4: UI ACTIONS
  // ==========================================
  const handleUndo = () => {
    if (history.length === 0) return;
    const prev = JSON.parse(history.pop());
    setHands(prev.hands); setLedger(prev.ledger); setRubberNum(prev.rubberNum); 
    setPlayers(prev.players); setArchive(prev.archive); setNames(prev.names); 
    setRubberCompleteStatus(prev.rubberCompleteStatus || null);
    setIsReviewingScorecard(false);
    if (prev.sessionStartTime) setSessionStartTime(prev.sessionStartTime);
    setHistory(history); setMenuModalVisible(false); jumpToTab(1);
  };

  const handleChipPress = (n) => {
    setNames({...names, [focusedInput]: n});
    if (focusedInput === 'we1' && !names.we2) setFocusedInput('we2');
    else if (focusedInput === 'we2' && !names.they1) setFocusedInput('they1');
    else if (focusedInput === 'they1' && !names.they2) setFocusedInput('they2');
    else if (focusedInput === 'they2' && !names.we1) setFocusedInput('we1');
  };

  const handleClearRecentPlayers = () => {
    safeConfirm("Are you sure?", "Permanently remove all saved player names?", () => { 
        const updatedNames = [];
        setAllNames(updatedNames); 
        setSettingsModalVisible(false); 
        saveActiveSessionImmediate({ allNames: updatedNames });
    });
  };

  const handleDeleteAllHistory = () => {
    safeConfirm("Are you sure?", "Permanently delete all archived sessions from History?", () => { 
        const updatedVault = [];
        setHistoryVault(updatedVault); 
        setSettingsModalVisible(false); 
        saveActiveSessionImmediate({ historyVault: updatedVault });
    });
  };

  const handleStartMatch = () => {
    const pArr = [names.we1.trim(), names.we2.trim(), names.they1.trim(), names.they2.trim()];
    if (pArr.some(n => !n)) return Alert.alert('Error', 'Enter all 4 names');
    if (new Set(pArr).size < 4) return Alert.alert('Error', 'Names must be unique');
    
    let newPlayers = { ...players }; let newAllNames = [...allNames];
    pArr.forEach(p => { 
      if (newPlayers[p] === undefined) newPlayers[p] = 0; 
      if (!newAllNames.includes(p)) newAllNames.push(p);
    });
    const startTime = (rubberNum === 1 && hands.length === 0 && archive.length === 0) ? getFormattedDate() : sessionStartTime;
    
    setPlayers(newPlayers); 
    setAllNames(newAllNames);
    if (startTime !== sessionStartTime) setSessionStartTime(startTime);
    
    setPlayerModalVisible(false); 
    jumpToTab(0);
    
    saveActiveSessionImmediate({ players: newPlayers, allNames: newAllNames, sessionStartTime: startTime });
  };

  const handleScoreIt = () => {
    triggerHaptic(); 
    const currentSnapshot = JSON.stringify({ hands, ledger, rubberNum, players, archive, names, sessionStartTime, rubberCompleteStatus });
    const newHistory = [...history, currentSnapshot];
    setHistory(newHistory);
    
    const newLogs = ScoringEngine.calculateHandScore(side, bidLevel, bidSuit, multiplier, honors, contractResult, ledger);

    let newLedger = { ...ledger };
    newLogs.forEach(log => {
      if (log.t === 'made') {
        if (log.g) { newLedger[log.s].games++; newLedger.we.partial = 0; newLedger.they.partial = 0; } 
        else { newLedger[log.s].partial += log.sc; }
      }
    });

    const finalHands = [...hands, ...newLogs];
    if (newLedger[side].games === 2) {
        closeOutRubber(finalHands, side);
    } else { 
        setHands(finalHands); 
        setLedger(newLedger); 
        resetBiddingBox(); 
        jumpToTab(1); 
        saveActiveSessionImmediate({ hands: finalHands, ledger: newLedger, history: newHistory });
    }
  };

  const closeOutRubber = (finalHands, winningSide) => {
    let oppGames = 0;
    if (winningSide) {
      const oppSide = (winningSide === 'we' ? 'they' : 'we');
      oppGames = ledger[oppSide].games;
      const bonus = (oppGames === 0) ? 700 : 500;
      finalHands.push({ s: winningSide, t: 'rub', section: 'above', sc: bonus, anno: 'rubber bonus' });
    }
    const weTotal = finalHands.filter(l => l.s === 'we').reduce((a, b) => a + b.sc, 0);
    const theyTotal = finalHands.filter(l => l.s === 'they').reduce((a, b) => a + b.sc, 0);
    const diff = Math.abs(weTotal - theyTotal);
    const ptWinner = weTotal > theyTotal ? 'WE' : 'THEY';
    
    const status = { winningSide, ptWinner, diff, weTotal, theyTotal, finalHands, oppGames };
    setHands(finalHands);
    setIsReviewingScorecard(false); 
    setRubberCompleteStatus(status);
    resetBiddingBox();
    saveActiveSessionImmediate({ hands: finalHands, rubberCompleteStatus: status });
  };

  const handleStartNextRubber = () => {
    const st = rubberCompleteStatus;
    let newPlayers = { ...players };
    if (st.weTotal > st.theyTotal) {
      newPlayers[names.we1] += st.diff; newPlayers[names.we2] += st.diff; newPlayers[names.they1] -= st.diff; newPlayers[names.they2] -= st.diff;
    } else if (st.theyTotal > st.weTotal) {
      newPlayers[names.we1] -= st.diff; newPlayers[names.we2] -= st.diff; newPlayers[names.they1] += st.diff; newPlayers[names.they2] += st.diff;
    }
    
    const newArchive = [{ num: rubberNum, names, weTotal: st.weTotal, theyTotal: st.theyTotal, hands: st.finalHands }, ...archive];
    const newRubberNum = rubberNum + 1;

    setArchive(newArchive);
    setPlayers(newPlayers); 
    setHands([]); 
    setLedger({ we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } });
    setRubberNum(newRubberNum); 
    setRubberCompleteStatus(null);
    setIsReviewingScorecard(false);
    setNames({ we1: '', we2: '', they1: '', they2: '' }); 
    setFocusedInput('we1');
    jumpToTab(0); 
    setTimeout(() => setPlayerModalVisible(true), 400);

    saveActiveSessionImmediate({ 
        archive: newArchive, 
        players: newPlayers, 
        hands: [], 
        ledger: { we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } }, 
        rubberNum: newRubberNum,
        rubberCompleteStatus: null,
        names: { we1: '', we2: '', they1: '', they2: '' }
    });
  };

  const handleForceNew = () => {
    safeConfirm("Are you sure?", "Apply unfinished rubber points (300/100) and end the current rubber?", () => {
      const finalHands = ScoringEngine.calculateUnfinishedBonus(ledger, hands);
      setMenuModalVisible(false); 
      closeOutRubber(finalHands, null);
    });
  };

  const confirmStartNewSession = () => {
    safeConfirm("Are you sure?", "Clear the board and archive this session to History?", () => handleStartNewSession(null));
  };

  const handleStartNewSession = (passedState = null) => {
    const st = passedState || { archive, hands, players, names, rubberNum, ledger, sessionStartTime };
    let finalArchive = [...(st.archive || [])];
    
    if (st.hands && st.hands.length > 0) {
      const h = ScoringEngine.calculateUnfinishedBonus(st.ledger, st.hands);
      const wT = h.filter(l => l.s === 'we').reduce((a, b) => a + b.sc, 0);
      const tT = h.filter(l => l.s === 'they').reduce((a, b) => a + b.sc, 0);
      finalArchive.unshift({ num: st.rubberNum, names: st.names, weTotal: wT, theyTotal: tT, hands: h });
    } else if (st.names && st.names.we1) {
      // Save stub scorecard if names exist but no hands played
      finalArchive.unshift({ num: st.rubberNum, names: st.names, weTotal: 0, theyTotal: 0, hands: [] });
    }
    
    const newVault = [...historyVault];
    if (finalArchive.length > 0) {
      newVault.unshift({ id: Date.now(), date: st.sessionStartTime || getFormattedDate(), name: null, players: st.players, archive: finalArchive });
      setHistoryVault(newVault);
    }
    
    setHands([]); setLedger({ we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } });
    setArchive([]); setHistory([]); setRubberNum(1); setPlayers({}); 
    setRubberCompleteStatus(null);
    setIsReviewingScorecard(false);
    setNames({ we1: '', we2: '', they1: '', they2: '' }); setFocusedInput('we1'); 
    setSessionStartTime(getFormattedDate()); setMenuModalVisible(false); resetBiddingBox(); jumpToTab(0);
    setTimeout(() => setPlayerModalVisible(true), 400);

    saveActiveSessionImmediate({
        historyVault: newVault,
        hands: [],
        ledger: { we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } },
        archive: [],
        history: [],
        rubberNum: 1,
        players: {},
        rubberCompleteStatus: null,
        names: { we1: '', we2: '', they1: '', they2: '' },
        sessionStartTime: getFormattedDate()
    });
  };

  const resetBiddingBox = () => { setSide(null); setBidLevel(null); setBidSuit(null); setMultiplier('n'); setHonors(0); setContractResult('made it'); };

  const handleShareVault = async (session) => {
    if (!session || !session.archive) return;
    const sideMap = { "we": 0, "they": 1 }; const typeMap = { "made": 0, "down": 1, "ot": 2, "hon": 3, "ins": 4, "slam": 5, "rub": 6 }; const multMap = { "n": 0, "x": 1, "xx": 2 };
    
    const cleanArch = session.archive.map(rub => ({ 
      n: [rub.names.we1, rub.names.we2, rub.names.they1, rub.names.they2].map(sanitize), 
      l: rub.hands.map(item => {
        let arr = [sideMap[item.s], typeMap[item.t], item.sc];
        if (item.t === 'made') arr.push(item.b || '', multMap[item.m] || 0, item.g ? 1 : 0);
        else if (item.t === 'down') arr.push(item.b || '', multMap[item.m] || 0, item.lbl || '');
        else if (item.t === 'ot') arr.push(item.cnt || 0); else if (item.t === 'slam') arr.push(item.lvl || 0);
        return arr;
      }) 
    }));
    
    const payload = LZString.compressToEncodedURIComponent(JSON.stringify([5, ["", "", "", ""], cleanArch, []]));
    const url = `https://eater.github.io/#${payload}`;
    let text = `Rubber Soul Session (${session.name || session.date})\n\n`;
    Object.entries(session.players).forEach(([p, s]) => text += `${p}: ${s > 0 ? '+' : ''}${s}\n`);
    text += `\nView full scorecards here:\n${url}`;
    try { await Share.share({ message: text }); } catch (e) { console.error(e); }
  };

  const handleDeleteVault = (id) => {
    Alert.alert("Are you sure?", "Permanently delete this session from History?", [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => { 
            const updatedVault = historyVault.filter(v => v.id !== id);
            setHistoryVault(updatedVault); 
            setSelectedVaultSession(null); 
            saveActiveSessionImmediate({ historyVault: updatedVault });
        } }
    ]);
  };

  const handleSaveRename = () => {
    if (!selectedVaultSession) return;
    const updatedVault = historyVault.map(v => 
      v.id === selectedVaultSession.id ? { ...v, name: renameText.trim() || null } : v
    );
    setHistoryVault(updatedVault);
    setSelectedVaultSession({ ...selectedVaultSession, name: renameText.trim() || null });
    setRenameModalVisible(false);
    saveActiveSessionImmediate({ historyVault: updatedVault });
  };

  const handleResumeVault = () => {
    safeConfirm("Resume Session", "This will save your current session to History and resume this one. Proceed?", () => {
      
      let newVault = [...historyVault];
      if (names.we1 || hands.length > 0 || archive.length > 0) {
        let stArchive = [...archive];
        if (hands.length > 0) {
          const h = ScoringEngine.calculateUnfinishedBonus(ledger, hands);
          const wT = h.filter(l => l.s === 'we').reduce((a, b) => a + b.sc, 0);
          const tT = h.filter(l => l.s === 'they').reduce((a, b) => a + b.sc, 0);
          stArchive.unshift({ num: rubberNum, names: names, weTotal: wT, theyTotal: tT, hands: h });
        } else if (names.we1) {
          // Save stub scorecard if names exist but no hands played
          stArchive.unshift({ num: rubberNum, names: names, weTotal: 0, theyTotal: 0, hands: [] });
        }
        
        if (stArchive.length > 0) {
          newVault.unshift({ id: Date.now(), date: sessionStartTime || getFormattedDate(), name: null, players: players, archive: stArchive });
        }
      }

      newVault = newVault.filter(v => v.id !== selectedVaultSession.id);

      const resumeArchive = selectedVaultSession.archive || [];
      const resumePlayers = selectedVaultSession.players || {};
      const resumeNames = (resumeArchive && resumeArchive.length > 0) ? resumeArchive[0].names : { we1: '', we2: '', they1: '', they2: '' };

      setHistoryVault(newVault);
      setArchive(resumeArchive);
      setPlayers(resumePlayers);
      setHands([]);
      setLedger({ we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } });
      setRubberNum(resumeArchive.length + 1);
      setSessionStartTime(selectedVaultSession.date);
      setHistory([]);
      setRubberCompleteStatus(null);
      setIsReviewingScorecard(false);
      resetBiddingBox();
      setNames(resumeNames);
      
      setSelectedVaultSession(null);
      jumpToTab(1); 

      saveActiveSessionImmediate({
          historyVault: newVault,
          archive: resumeArchive,
          players: resumePlayers,
          hands: [],
          ledger: { we: { games: 0, partial: 0 }, they: { games: 0, partial: 0 } },
          rubberNum: resumeArchive.length + 1,
          sessionStartTime: selectedVaultSession.date,
          history: [],
          rubberCompleteStatus: null,
          names: resumeNames
      });
    });
  };

  // ==========================================
  // ZONE 5: RENDERERS & LOGIC BLOCKS
  // ==========================================
  
  let reviewHeading = "Rubber Complete!";
  let rubberTypeStr = "Unfinished rubber.";
  if (rubberCompleteStatus?.winningSide) {
    const gamesTxt = rubberCompleteStatus.oppGames === 0 ? "two-game" : "three-game";
    rubberTypeStr = `${rubberCompleteStatus.winningSide.toUpperCase()} won a ${gamesTxt} rubber.`;
  } else if (rubberCompleteStatus) {
    reviewHeading = "Rubber Ended Early";
  }

  const renderColoredText = (text, styleProps) => {
    if (!text) return null;
    const parts = text.split(/([♣♦♥♠])/g);
    return (
      <Text style={[styles.annoText, styleProps]} numberOfLines={2}>
        {parts.map((part, i) => {
          if (['♣', '♦', '♥', '♠'].includes(part)) return <Text key={i} style={{ color: getSuitColor(part) }}>{part}{'\uFE0E'}</Text>;
          return part;
        })}
      </Text>
    );
  };

  const renderRowItem = (h, isWe) => (
    <View key={Math.random().toString()} style={styles.scoreRow} accessible={true} accessibilityLabel={`${h.s} scored ${h.sc} for ${h.anno}`}>
      {isWe ? (
        <View style={styles.scoreRowWe}>
          <View style={styles.annoContainerWe}>{renderColoredText(h.anno, { textAlign: 'left' })}</View>
          <View style={[styles.scoreCellWe, h.g && h.section === 'below' && styles.gameLine]}>
            <Text style={[styles.scoreText, h.section === 'below' ? { color: COLORS.inkCrimson } : { color: COLORS.inkCharcoal }]}>{h.sc}</Text>
          </View>
        </View>
      ) : (
        <View style={styles.scoreRowThey}>
          <View style={[styles.scoreCellThey, h.g && h.section === 'below' && styles.gameLine]}>
            <Text style={[styles.scoreText, h.section === 'below' ? { color: COLORS.inkCrimson } : { color: COLORS.inkCharcoal }]}>{h.sc}</Text>
          </View>
          <View style={styles.annoContainerThey}>{renderColoredText(h.anno, { textAlign: 'right' })}</View>
        </View>
      )}
    </View>
  );

  const renderScorecard = (customHands, customLedger, customNames) => (
      <View style={styles.scorecardWindow} accessible={true} accessibilityRole="summary">
        <View style={styles.scorecardHeaderRow}>
          
          <TouchableOpacity 
            style={styles.headerCellWe} 
            activeOpacity={0.6}
            disabled={!customNames.we1 || !!rubberCompleteStatus} 
            onPress={() => { triggerHaptic(); setSide('we'); jumpToTab(0); }}
            accessibilityRole="button"
            accessibilityLabel="Select WE side to record a score"
          >
            <View style={{ alignItems: 'center' }}>
              <View style={customLedger.we.games > 0 && styles.vulnWrapper}><Text style={styles.headerTitle}>WE</Text></View>
              <Text style={styles.playerName}>{customNames.we1}{'\n'}{customNames.we2}</Text>
            </View>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.headerCellThey} 
            activeOpacity={0.6}
            disabled={!customNames.we1 || !!rubberCompleteStatus} 
            onPress={() => { triggerHaptic(); setSide('they'); jumpToTab(0); }}
            accessibilityRole="button"
            accessibilityLabel="Select THEY side to record a score"
          >
            <View style={{ alignItems: 'center' }}>
              <View style={customLedger.they.games > 0 && styles.vulnWrapper}><Text style={styles.headerTitle}>THEY</Text></View>
              <Text style={styles.playerName}>{customNames.they1}{'\n'}{customNames.they2}</Text>
            </View>
          </TouchableOpacity>
          
        </View>
        
        <View style={styles.scoreArea}>
          <View style={[styles.halfColumn, { justifyContent: 'flex-end' }]}>
              {customHands.filter(h => h.s === 'we' && h.section === 'above').slice().reverse().map(h => renderRowItem(h, true))}
          </View>
          <View style={[styles.halfColumnThey, { justifyContent: 'flex-end' }]}>
              {customHands.filter(h => h.s === 'they' && h.section === 'above').slice().reverse().map(h => renderRowItem(h, false))}
          </View>
        </View>
        
        <View style={styles.theLine} />
        
        <View style={styles.scoreArea}>
          <View style={[styles.halfColumn, { justifyContent: 'flex-start' }]}>{customHands.filter(h => h.s === 'we' && h.section === 'below').map(h => renderRowItem(h, true))}</View>
          <View style={[styles.halfColumnThey, { justifyContent: 'flex-start' }]}>{customHands.filter(h => h.s === 'they' && h.section === 'below').map(h => renderRowItem(h, false))}</View>
        </View>
      </View>
  );

  const renderBidTab = () => {
    return (
      <ScrollView bounces={false} contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false}>
        <View style={styles.panel}>
          <View style={[StyleSheet.absoluteFill, {justifyContent: 'center', alignItems: 'center', zIndex: -1}]} pointerEvents="none">
             <Text style={{fontSize: 400, color: 'rgba(27, 94, 32, 0.04)'}}>{'♠\uFE0E'}</Text>
          </View>
          
          {!names.we1 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No active rubber.</Text>
              <TouchableOpacity style={[styles.scoreButton, { marginTop: 20, width: 220 }]} onPress={() => { setFocusedInput('we1'); setPlayerModalVisible(true); }} accessibilityRole="button" accessibilityLabel="Start a new rubber">
                <Text style={styles.scoreButtonText}>Start Rubber</Text>
              </TouchableOpacity>
            </View>
          ) : rubberCompleteStatus ? (
            <View style={styles.emptyState}>
              <Text style={styles.reviewTitle} accessibilityRole="header">{reviewHeading}</Text>
              <Text style={styles.reviewText}>{rubberTypeStr}</Text>
              <Text style={[styles.reviewText, { marginBottom: 30 }]}>Final score: {rubberCompleteStatus.ptWinner} by {rubberCompleteStatus.diff} points.</Text>
              <TouchableOpacity style={styles.scoreButton} onPress={handleStartNextRubber} accessibilityRole="button" accessibilityLabel="Start next rubber">
                <Text style={styles.scoreButtonText}>Start Next Rubber</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ width: '100%' }}>
              <View style={styles.activeBidWrapper}>
                {side && bidLevel && bidSuit && (
                   <Text style={styles.liveContract} accessibilityRole="text" accessibilityLabel={`Current bid is ${bidLevel} ${bidSuit}`}>
                      {bidLevel} <Text style={{ color: getSuitColor(bidSuit) }}>{bidSuit === 'NT' ? 'NT' : bidSuit + '\uFE0E'}</Text>
                      {multiplier === 'x' ? ' x' : multiplier === 'xx' ? ' xx' : ''}
                   </Text>
                )}
              </View>

              <View style={[styles.row, { marginBottom: 15 }]}>
                <TouchableOpacity style={[styles.btn, side === 'we' && styles.btnActive]} onPress={() => { triggerHaptic(); setSide('we'); }} accessibilityRole="button" accessibilityLabel="Select WE side"><Text style={[styles.btnText, side === 'we' && styles.btnTextActive]}>WE</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.btn, side === 'they' && styles.btnActive]} onPress={() => { triggerHaptic(); setSide('they'); }} accessibilityRole="button" accessibilityLabel="Select THEY side"><Text style={[styles.btnText, side === 'they' && styles.btnTextActive]}>THEY</Text></TouchableOpacity>
              </View>

              {!side ? (
                <View style={{ paddingVertical: 60, alignItems: 'center' }}>
                  <Text style={{ fontSize: 16, color: '#9e9e9e', fontStyle: 'italic' }}>Tap WE or THEY to record a hand</Text>
                </View>
              ) : (
                <>
                  <View style={styles.gridContainer}>
                    {Array.from({ length: 7 }, (_, i) => i + 1).map(level => (
                      <View key={level} style={styles.gridRow}>
                        {CONFIG.suits.map(suit => {
                          const isSelected = bidLevel === level && bidSuit === suit;
                          const trickPts = ScoringEngine.calcTrickBase(suit, level) * (multiplier === 'x' ? 2 : multiplier === 'xx' ? 4 : 1);
                          const isGame = (ledger[side].partial + trickPts >= 100);
                          const btnColor = isSelected ? '#e0e0e0' : (isGame ? '#ffebee' : '#e3f2fd'); 
                          const activeStyle = isSelected ? { borderTopWidth: 2, borderLeftWidth: 2, borderBottomWidth: 0, borderRightWidth: 0, borderColor: '#aaa' } : {};
                          return (
                            <TouchableOpacity key={`${level}${suit}`} style={[styles.bidButton, { backgroundColor: btnColor }, activeStyle]} onPress={() => { triggerHaptic(); setBidLevel(level); setBidSuit(suit); setContractResult('made it'); }} accessibilityRole="button" accessibilityLabel={`Bid ${level} ${suit}`}>
                              <Text style={[styles.bidText, isSelected && styles.bidTextActive]}>
                                {level}<Text style={{ color: getSuitColor(suit) }}>{suit === 'NT' ? suit : suit + '\uFE0E'}</Text>
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                  
                  <View style={[styles.row, { marginTop: 10 }]}>
                    <TouchableOpacity style={[styles.btnSmall, multiplier === 'x' && styles.btnActive]} onPress={() => { triggerHaptic(); setMultiplier(multiplier === 'x' ? 'n' : 'x'); }} accessibilityRole="button" accessibilityLabel="Double contract"><Text style={[styles.btnTextSmall, multiplier === 'x' && styles.btnTextActive]}>Doubled</Text></TouchableOpacity>
                    <TouchableOpacity style={[styles.btnSmall, multiplier === 'xx' && styles.btnActive]} onPress={() => { triggerHaptic(); setMultiplier(multiplier === 'xx' ? 'n' : 'xx'); }} accessibilityRole="button" accessibilityLabel="Redouble contract"><Text style={[styles.btnTextSmall, multiplier === 'xx' && styles.btnTextActive]}>Redoubled</Text></TouchableOpacity>
                  </View>
                  
                  {settings.showHonors && (
                    <View style={[styles.row, { marginTop: 8 }]}>
                      <TouchableOpacity style={[styles.btnSmall, honors === 100 && styles.btnActive]} onPress={() => { triggerHaptic(); setHonors(honors === 100 ? 0 : 100); }} accessibilityRole="button" accessibilityLabel="Score 100 honors"><Text style={[styles.btnTextSmall, honors === 100 && styles.btnTextActive]}>100 honors</Text></TouchableOpacity>
                      <TouchableOpacity style={[styles.btnSmall, honors === 150 && styles.btnActive]} onPress={() => { triggerHaptic(); setHonors(honors === 150 ? 0 : 150); }} accessibilityRole="button" accessibilityLabel="Score 150 honors"><Text style={[styles.btnTextSmall, honors === 150 && styles.btnTextActive]}>150 honors</Text></TouchableOpacity>
                    </View>
                  )}
                  
                  {bidLevel && bidSuit && (
                    <View style={{ width: '100%', marginTop: 15 }}>
                      <TouchableOpacity style={styles.pickerButton} onPress={() => setResultModalVisible(true)} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel="Change contract result">
                        <Text style={styles.pickerText}>Result: <Text style={{ fontWeight: 'bold', color: '#1b5e20' }}>{contractResult}</Text></Text>
                        <Text style={styles.pickerChevron}>▼</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.scoreButton} onPress={handleScoreIt} accessibilityRole="button" accessibilityLabel="Score hand"><Text style={styles.scoreButtonText}>Score</Text></TouchableOpacity>
                    </View>
                  )}
                </>
              )}
            </View>
          )}
        </View>
      </ScrollView>
    );
  };

  const renderResultsTab = () => (
    <ScrollView style={{ flex: 1, width: '100%' }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 15, paddingVertical: 20 }}>
      <View style={styles.ledgerSummary}>
        <Text style={styles.sectionSubHeader}>CUMULATIVE</Text>
        {Object.keys(players).length === 0 ? <Text style={{ color:'#666' }}>No data yet.</Text> : (
          <View style={styles.tallyGrid}>
            {Object.entries(players).map(([p, score]) => (
              <View key={p} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold' }}>{p}</Text>
                <Text style={{ fontSize: 18, color: score > 0 ? '#1b5e20' : score < 0 ? '#d32f2f' : '#333' }}>{score > 0 ? '+' : ''}{score}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      <Text style={[styles.sectionSubHeader, { marginTop: 20 }]}>SCORECARDS</Text>
      {archive.length === 0 ? ( <Text style={{ color: '#666', textAlign: 'center' }}>No completed rubbers yet.</Text> ) : (
        archive.map((rub, i) => (
          <View key={i} style={{ marginBottom: 20, width: '100%', alignItems: 'center' }}>
            <Text style={styles.archiveHeaderText}>Rubber #{rub.num}</Text>
            {renderScorecard(rub.hands, { we: {games:0, partial:0}, they: {games:0, partial:0} }, rub.names)}
          </View>
        ))
      )}
    </ScrollView>
  );

  // --- ARCHIVE VIEW SCREEN ---
  if (selectedVaultSession) {
    return (
      <View style={[styles.safeArea, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => setSelectedVaultSession(null)} style={{ padding: 5, position: 'absolute', left: 10, zIndex: 10, flexDirection: 'row', alignItems: 'center' }} accessibilityRole="button" accessibilityLabel="Go back">
            <Ionicons name="chevron-back" size={26} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold', marginLeft: 2 }}>Back</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}><Text style={styles.headerText} accessibilityRole="header">History</Text></View>
        </View>
        <View style={styles.content}>
          <ScrollView style={{ flex: 1, padding: 10 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center' }}>
            <View style={styles.vaultHeaderCard}>
              <View style={{flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5}}>
                <Text style={styles.vaultDateText}>{selectedVaultSession.name || selectedVaultSession.date}</Text>
                <TouchableOpacity onPress={() => { setRenameText(selectedVaultSession.name || ''); setRenameModalVisible(true); }} accessibilityRole="button" accessibilityLabel="Name this session">
                  <Text style={{color: '#0047AB', fontWeight: 'bold', fontSize: 16}}>Name Session</Text>
                </TouchableOpacity>
              </View>
              {selectedVaultSession.name && <Text style={{fontSize: 14, color: '#666', marginBottom: 5}}>{selectedVaultSession.date}</Text>}
              <Text style={{ fontSize: 16, marginBottom: 5 }}>Rubbers Played: {selectedVaultSession.archive?.length || 0}</Text>
              
              <View style={styles.vaultSummaryLine}>
                {Object.entries(selectedVaultSession.players).map(([p, s]) => (
                  <View key={p} style={styles.historyColumnRow}>
                    <Text style={styles.historyColumnName}>{p}</Text>
                    <View style={styles.historyColumnScoreBox}>
                      <Text style={[styles.historyColumnScore, { color: s > 0 ? '#1b5e20' : s < 0 ? '#d32f2f' : '#333' }]}>
                        {s > 0 ? '+' : ''}{s}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </View>

            {selectedVaultSession.archive?.map((rub, i) => (
              <View key={i} style={{ marginBottom: 20, width: '100%', maxWidth: 450 }}>
                <Text style={styles.archiveHeaderText}>Rubber #{rub.num}</Text>
                {renderScorecard(rub.hands, { we: {games:0, partial:0}, they: {games:0, partial:0} }, rub.names)}
              </View>
            ))}
          </ScrollView>
        </View>
        <View style={{ backgroundColor: '#fff', padding: 15, borderTopWidth: 1, borderColor: '#ccc', flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
          <TouchableOpacity style={[styles.modalBtn, { flex: 1, minWidth: '45%', backgroundColor: '#f3e5f5', borderColor: '#9c27b0', marginBottom: 0 }]} onPress={handleResumeVault} accessibilityRole="button" accessibilityLabel="Resume this session">
            <Text style={[styles.modalBtnText, { color: '#6a1b9a' }]}>Resume</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.modalBtn, { flex: 1, minWidth: '45%', backgroundColor: '#e3f2fd', borderColor: '#1E90FF', marginBottom: 0 }]} onPress={() => handleShareVault(selectedVaultSession)} accessibilityRole="button" accessibilityLabel="Share session details">
            <Text style={[styles.modalBtnText, { color: '#0047AB' }]}>Share</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.modalBtn, { width: '100%', borderColor: '#d32f2f', backgroundColor: '#ffebee', marginBottom: 0, marginTop: 5 }]} onPress={() => handleDeleteVault(selectedVaultSession.id)} accessibilityRole="button" accessibilityLabel="Delete this session">
            <Text style={[styles.modalBtnText, { color: '#d32f2f' }]}>Delete Session</Text>
          </TouchableOpacity>
        </View>
        <View style={{ height: insets.bottom, backgroundColor: COLORS.primaryGreen }} />

        <Modal visible={renameModalVisible} animationType="fade" transparent={true} onRequestClose={() => setRenameModalVisible(false)}>
          <View style={styles.modalOverlayCentered}>
            <View style={styles.playerCard}>
              <Text style={styles.modalTitle} accessibilityRole="header">Name Session</Text>
              <TextInput style={styles.input} value={renameText} onChangeText={setRenameText} placeholder="e.g. Friday Night Bridge" autoCapitalize="words" autoFocus={true} accessibilityLabel="Enter session name" />
              <TouchableOpacity style={[styles.scoreButton, {marginTop: 15}]} onPress={handleSaveRename} accessibilityRole="button" accessibilityLabel="Save session name"><Text style={styles.scoreButtonText}>Save</Text></TouchableOpacity>
              <TouchableOpacity style={{ marginTop: 15, padding: 10 }} onPress={() => setRenameModalVisible(false)} accessibilityRole="button" accessibilityLabel="Cancel renaming"><Text style={styles.subCloseText}>Cancel</Text></TouchableOpacity>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  // --- MAIN APP VIEW ---
  return (
    <View style={[styles.safeArea, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />
      
      <View style={styles.header}>
        <View style={{ flex: 1, alignItems: 'flex-start' }}>
          <TouchableOpacity onPress={() => setMenuModalVisible(true)} style={styles.headerMenuBtn} accessibilityRole="button" accessibilityLabel="Open Menu">
            <Text style={styles.menuIcon}>☰</Text>
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerText} accessibilityRole="header">Rubber #{rubberNum}</Text>
        </View>
        <View style={{ flex: 1 }} />
      </View>

      <View style={styles.content}>
        {isTablet ? (
          <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={styles.tabletColLeft}>{renderBidTab()}</View>
            <View style={styles.tabletColRight}>
              <ScrollView contentContainerStyle={{ alignItems: 'center', paddingVertical: 20 }} showsVerticalScrollIndicator={false}>
                 {renderScorecard(hands, ledger, names)}
                 {archive.map((rub, i) => (
                    <View key={i} style={{ marginTop: 30, width: '100%', alignItems: 'center' }}>
                       <Text style={styles.archiveHeaderText}>Rubber #{rub.num}</Text>
                       {renderScorecard(rub.hands, { we: {games:0, partial:0}, they: {games:0, partial:0} }, rub.names)}
                    </View>
                 ))}
              </ScrollView>
            </View>
          </View>
        ) : (
          <PagerView ref={pagerRef} style={{ flex: 1 }} initialPage={0} onPageSelected={(e) => setActiveTab(e.nativeEvent.position)}>
            <View key="0" style={styles.mobilePage}>{renderBidTab()}</View>
            <View key="1" style={styles.mobilePage}>
              <ScrollView style={{ flex: 1, width: '100%' }} contentContainerStyle={{ paddingVertical: 20, alignItems: 'center', paddingHorizontal: 10 }} showsVerticalScrollIndicator={false}>
                {renderScorecard(hands, ledger, names)}
              </ScrollView>
            </View>
            <View key="2" style={styles.mobilePage}>{renderResultsTab()}</View>
          </PagerView>
        )}
      </View>
      
      {!isTablet && (
        <>
          <View style={styles.tabBar}>
            <TouchableOpacity style={styles.tabItem} onPress={() => jumpToTab(0)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Go to Bid Tab">
              <View style={[styles.tabIndicator, activeTab === 0 && styles.tabIndicatorActive]} />
              <Text style={[styles.tabLabel, activeTab === 0 && styles.tabLabelActive]}>BID</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.tabItem} onPress={() => jumpToTab(1)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Go to Scorecard Tab">
              <View style={[styles.tabIndicator, activeTab === 1 && styles.tabIndicatorActive]} />
              <Text style={[styles.tabLabel, activeTab === 1 && styles.tabLabelActive]}>SCORE</Text>
            </TouchableOpacity>
            
            <TouchableOpacity style={styles.tabItem} onPress={() => jumpToTab(2)} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Go to Results Tab">
              <View style={[styles.tabIndicator, activeTab === 2 && styles.tabIndicatorActive]} />
              <Text style={[styles.tabLabel, activeTab === 2 && styles.tabLabelActive]}>RESULTS</Text>
            </TouchableOpacity>
          </View>
          <View style={{ height: insets.bottom, backgroundColor: COLORS.primaryGreen }} />
        </>
      )}

      {/* --- ALL MODALS --- */}
      <Modal visible={!isTablet && !!rubberCompleteStatus && !isReviewingScorecard} animationType="fade" transparent={true}>
        <View style={styles.modalOverlayCentered}>
          <View style={styles.playerCard} accessible={true} accessibilityRole="alert">
             <Text style={styles.reviewTitle} accessibilityRole="header">{reviewHeading}</Text>
             <Text style={styles.reviewText}>{rubberTypeStr}</Text>
             <Text style={[styles.reviewText, { marginBottom: 30 }]}>Final score: {rubberCompleteStatus?.ptWinner} by {rubberCompleteStatus?.diff} points.</Text>
             <TouchableOpacity style={styles.scoreButton} onPress={handleStartNextRubber} accessibilityRole="button" accessibilityLabel="Start next rubber">
               <Text style={styles.scoreButtonText}>Start Next Rubber</Text>
             </TouchableOpacity>
             <TouchableOpacity style={{ marginTop: 15, padding: 10 }} onPress={() => setIsReviewingScorecard(true)} accessibilityRole="button" accessibilityLabel="Review Scorecard">
               <Text style={styles.subCloseText}>Review Scorecard</Text>
             </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={sessionFoundModalVisible} animationType="fade" transparent={true} onRequestClose={() => setSessionFoundModalVisible(false)}>
        <View style={styles.modalOverlayCentered}>
          <View style={styles.playerCard} accessible={true} accessibilityRole="alert">
            <Text style={styles.modalTitle} accessibilityRole="header">Session Found</Text>
            <Text style={{fontSize: 16, marginBottom: 25, color: '#333'}}>You have a session in progress.</Text>
            <View style={{flexDirection: 'row', justifyContent: 'space-between', width: '100%', gap: 10}}>
                <TouchableOpacity style={[styles.btn, {backgroundColor: '#fff', borderColor: '#0a0'}]} onPress={() => setSessionFoundModalVisible(false)} accessibilityRole="button" accessibilityLabel="Continue Session">
                    <Text style={{fontSize: 16, fontWeight: 'bold', color: '#004d00', textAlign: 'center'}}>CONTINUE</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, {backgroundColor: '#ffebee', borderColor: '#d32f2f'}]} onPress={() => { setSessionFoundModalVisible(false); handleStartNewSession(sessionFoundData); }} accessibilityRole="button" accessibilityLabel="Start New Session">
                    <Text style={{fontSize: 16, fontWeight: 'bold', color: '#d32f2f', textAlign: 'center'}}>START NEW</Text>
                </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={playerModalVisible} animationType="fade" transparent={true} onRequestClose={() => setPlayerModalVisible(false)}>
        <View style={styles.modalOverlayCentered}><View style={styles.playerCard}>
          <Text style={styles.modalTitle} accessibilityRole="header">New Rubber</Text>
          {settings.showRecentPlayers !== false && allNames.filter(n => ![names.we1, names.we2, names.they1, names.they2].includes(n)).length > 0 && (
            <View style={styles.chipBox}>
              <View style={styles.chipRow}>{allNames.filter(n => ![names.we1, names.we2, names.they1, names.they2].includes(n)).reverse().slice(0, 6).map(n => (
                <TouchableOpacity key={n} style={styles.nameChip} onPress={() => handleChipPress(n)} accessibilityRole="button" accessibilityLabel={`Add player ${n}`}><Text style={{ color: '#fff' }}>{n}</Text></TouchableOpacity>
              ))}</View>
            </View>
          )}
          <View style={styles.inputRow}>
            <View style={styles.inputCol}><Text style={styles.inputLabel}>WE</Text>
              <TextInput style={[styles.input, focusedInput === 'we1' && styles.focusedInput]} value={names.we1} onChangeText={t => setNames({...names, we1: t})} onFocus={() => setFocusedInput('we1')} placeholder="Player 1" autoCapitalize="words" accessibilityLabel="Enter WE player 1" />
              <TextInput style={[styles.input, focusedInput === 'we2' && styles.focusedInput]} value={names.we2} onChangeText={t => setNames({...names, we2: t})} onFocus={() => setFocusedInput('we2')} placeholder="Player 2" autoCapitalize="words" accessibilityLabel="Enter WE player 2" />
            </View>
            <View style={styles.inputCol}><Text style={styles.inputLabel}>THEY</Text>
              <TextInput style={[styles.input, focusedInput === 'they1' && styles.focusedInput]} value={names.they1} onChangeText={t => setNames({...names, they1: t})} onFocus={() => setFocusedInput('they1')} placeholder="Player 3" autoCapitalize="words" accessibilityLabel="Enter THEY player 1" />
              <TextInput style={[styles.input, focusedInput === 'they2' && styles.focusedInput]} value={names.they2} onChangeText={t => setNames({...names, they2: t})} onFocus={() => setFocusedInput('they2')} placeholder="Player 4" autoCapitalize="words" accessibilityLabel="Enter THEY player 2" />
            </View>
          </View>
          <TouchableOpacity style={styles.scoreButton} onPress={handleStartMatch} accessibilityRole="button" accessibilityLabel="Start Match"><Text style={styles.scoreButtonText}>Start Match</Text></TouchableOpacity>
          <TouchableOpacity style={{ marginTop: 15, padding: 10 }} onPress={() => setPlayerModalVisible(false)} accessibilityRole="button" accessibilityLabel="Cancel and view scorecard"><Text style={styles.subCloseText}>Cancel (View Scorecard)</Text></TouchableOpacity>
        </View></View>
      </Modal>

      <BaseModal visible={menuModalVisible} onClose={() => setMenuModalVisible(false)} title="Menu" insets={insets}>
        <TouchableOpacity style={[styles.modalBtn, history.length === 0 && { opacity: 0.5 }]} disabled={history.length === 0} onPress={handleUndo} accessibilityRole="button">
          <Text style={styles.modalBtnText}>Undo Last Score</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.modalBtn} onPress={() => { names.we1 ? handleForceNew() : (setMenuModalVisible(false), setTimeout(()=>setPlayerModalVisible(true), 300)) }} accessibilityRole="button">
          <Text style={styles.modalBtnText}>{names.we1 ? "End Current Rubber" : "Start New Rubber"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modalBtn, { borderColor: '#d32f2f', backgroundColor: '#ffebee' }]} onPress={confirmStartNewSession} accessibilityRole="button">
          <Text style={[styles.modalBtnText, { color: '#d32f2f' }]}>Start New Session</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modalBtn, { marginTop: 15 }]} onPress={() => { setMenuModalVisible(false); setTimeout(() => setHistoryModalVisible(true), 300) }} accessibilityRole="button">
          <Text style={styles.modalBtnText}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.modalBtn} onPress={() => { setMenuModalVisible(false); setTimeout(() => setSettingsModalVisible(true), 300) }} accessibilityRole="button">
          <Text style={styles.modalBtnText}>Settings</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.modalBtn} onPress={() => { setMenuModalVisible(false); setTimeout(() => setAboutModalVisible(true), 300) }} accessibilityRole="button">
          <Text style={styles.modalBtnText}>About</Text>
        </TouchableOpacity>
      </BaseModal>

      <BaseModal visible={resultModalVisible} onClose={() => setResultModalVisible(false)} title="Contract Result" insets={insets}>
        <ScrollView ref={modalScrollRef} style={{ width: '100%', maxHeight: 300 }} showsVerticalScrollIndicator={false}>
          {ScoringEngine.generateResultOptions(bidLevel).map((opt, idx) => (
            <TouchableOpacity key={idx} style={styles.modalOption} onPress={() => { setContractResult(opt); setResultModalVisible(false); }} accessibilityRole="button" accessibilityLabel={`Select result ${opt}`}>
              <Text style={[styles.modalOptionText, contractResult === opt && { color: '#0a0', fontWeight: 'bold' }]}>{opt}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </BaseModal>

      <BaseModal visible={settingsModalVisible} onClose={() => setSettingsModalVisible(false)} title="Settings" insets={insets}>
        <View style={{ width: '100%' }}>
          <View style={styles.settingRow}><Text style={styles.settingText} accessibilityRole="text">4-Color Deck</Text><Switch value={settings.fourColor} onValueChange={(val) => setSettings({...settings, fourColor: val})} trackColor={{ true: '#a5d6a7' }} thumbColor={settings.fourColor ? '#1b5e20' : '#f4f3f4'} accessibilityLabel="Toggle 4-Color Deck" /></View>
          <View style={styles.settingRow}><Text style={styles.settingText} accessibilityRole="text">Show Honors Buttons</Text><Switch value={settings.showHonors} onValueChange={(val) => setSettings({...settings, showHonors: val})} trackColor={{ true: '#a5d6a7' }} thumbColor={settings.showHonors ? '#1b5e20' : '#f4f3f4'} accessibilityLabel="Toggle Honors Buttons" /></View>
          <View style={styles.settingRow}><Text style={styles.settingText} accessibilityRole="text">Show Recent Player Tiles</Text><Switch value={settings.showRecentPlayers !== false} onValueChange={(val) => setSettings({...settings, showRecentPlayers: val})} trackColor={{ true: '#a5d6a7' }} thumbColor={settings.showRecentPlayers !== false ? '#1b5e20' : '#f4f3f4'} accessibilityLabel="Toggle Recent Player Tiles" /></View>
          <View style={styles.settingRow}><Text style={styles.settingText} accessibilityRole="text">Keep Screen Awake</Text><Switch value={settings.keepAwake} onValueChange={(val) => setSettings({...settings, keepAwake: val})} trackColor={{ true: '#a5d6a7' }} thumbColor={settings.keepAwake ? '#1b5e20' : '#f4f3f4'} accessibilityLabel="Toggle Keep Screen Awake" /></View>
          <View style={styles.settingRow}><Text style={styles.settingText} accessibilityRole="text">Haptic Feedback</Text><Switch value={settings.haptics} onValueChange={(val) => setSettings({...settings, haptics: val})} trackColor={{ true: '#a5d6a7' }} thumbColor={settings.haptics ? '#1b5e20' : '#f4f3f4'} accessibilityLabel="Toggle Haptic Feedback" /></View>
          <View style={{flexDirection: 'row', gap: 10, marginTop: 15}}>
            <TouchableOpacity style={[styles.settingsDangerBtn, {flex: 1}]} onPress={handleClearRecentPlayers} accessibilityRole="button"><Text style={styles.dangerBtnText}>Clear Recent Players</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.settingsDangerBtn, {flex: 1}]} onPress={handleDeleteAllHistory} accessibilityRole="button"><Text style={styles.dangerBtnText}>Delete All History</Text></TouchableOpacity>
          </View>
        </View>
      </BaseModal>

      <BaseModal visible={historyModalVisible} onClose={() => setHistoryModalVisible(false)} title="History" insets={insets}>
        <ScrollView style={{ width: '100%', maxHeight: 400 }} showsVerticalScrollIndicator={false}>
          {historyVault.length === 0 ? <Text style={styles.emptyVaultText}>No archived sessions.</Text> : (
            historyVault.map((v) => (
              <TouchableOpacity key={v.id} style={styles.archiveCard} onPress={() => { setHistoryModalVisible(false); setTimeout(() => setSelectedVaultSession(v), 300); }} accessibilityRole="button" accessibilityLabel={`View session from ${v.date}`}>
                <Text style={styles.vaultCardDate}>{v.name ? `${v.name} (${v.date})` : v.date}</Text>
                
                {/* Formatted Column Grid for List View */}
                <View style={{ width: '100%', marginTop: 5 }}>
                  {Object.entries(v.players).map(([p, s]) => (
                    <View key={p} style={styles.historyColumnRow}>
                      <Text style={styles.historyColumnName}>{p}</Text>
                      <View style={styles.historyColumnScoreBox}>
                        <Text style={[styles.historyColumnScore, { color: s > 0 ? '#1b5e20' : s < 0 ? '#d32f2f' : '#333' }]}>
                          {s > 0 ? '+' : ''}{s}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>

              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </BaseModal>

      <BaseModal visible={aboutModalVisible} onClose={() => setAboutModalVisible(false)} title="Rubber Soul" insets={insets}>
      <Text style={{ fontSize: 16, marginBottom: 10 }}>The rubber bridge scorer</Text>
      <Text style={{ fontSize: 16 }}>Copyright 2009-{new Date().getFullYear()}</Text>
      <Text style={{ fontSize: 16, marginBottom: 30 }}>by Paul Adams</Text>

      <TouchableOpacity 
      onPress={() => Linking.openURL('https://eater.github.io/rubbersoul-policy/')} 
      accessibilityRole="button" 
      accessibilityLabel="Open Privacy Policy"
      >
      <Text style={{ fontSize: 12, color: '#666', textDecorationLine: 'underline' }}>
      Privacy Policy
      </Text>
      </TouchableOpacity>
      </BaseModal>
      </View>
  );
}

// ==========================================
// ZONE 6: MASTER STYLESHEET & COLORS
// ==========================================

const COLORS = {
  primaryGreen: '#1b5e20',
  backgroundMint: '#e8f5e9', 
  paperIvory: '#fdfbf7', 
  inkCharcoal: '#333333', 
  inkCrimson: '#c62828', 
  gold: '#FFD700', 
};

const styles = StyleSheet.create({
  
  safeArea: { flex: 1, backgroundColor: COLORS.primaryGreen },
  header: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 15, paddingVertical: 10, alignItems: 'center' },
  headerText: { color: '#fff', fontSize: 22, fontWeight: 'bold' },
  headerMenuBtn: { padding: 5 },
  menuIcon: { color: '#fff', fontSize: 28, fontWeight: 'bold' },
  content: { flex: 1, backgroundColor: COLORS.backgroundMint },
  mobilePage: { width: SCREEN_WIDTH },
  
  tabletColLeft: { flex: 4, padding: 15 },
  tabletColRight: { flex: 6, paddingHorizontal: 15 },
  
  panel: { backgroundColor: '#fff', borderRadius: 12, padding: 12, flex: 1, overflow: 'hidden', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5, elevation: 3 },
  title: { fontSize: 22, fontWeight: 'bold', color: COLORS.primaryGreen, marginBottom: 10 },
  sectionSubHeader: { fontSize: 13, color: '#888', fontWeight: 'bold', letterSpacing: 1.5, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'center', width: '100%', gap: 10 },
  btn: { flex: 1, paddingVertical: 10, backgroundColor: '#f0f0f0', borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#ccc' },
  btnActive: { backgroundColor: '#dcedc8', borderColor: '#689f38' },
  btnText: { fontSize: 18, fontWeight: 'bold', color: '#333' },
  btnTextActive: { color: '#2e7d32' },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 12, marginHorizontal: 4, backgroundColor: '#f0f0f0', borderRadius: 6, borderWidth: 1, borderColor: '#ccc' },
  btnTextSmall: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyText: { fontSize: 18, color: '#757575', fontStyle: 'italic' },
  activeBidWrapper: { height: 40, width: '100%', justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  liveContract: { fontSize: 28, fontWeight: 'bold', textAlign: 'center' },
  gridContainer: { width: '100%', maxWidth: 500, marginTop: 10 },
  gridRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  bidButton: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 6, height: 40, marginHorizontal: 2, justifyContent: 'center', alignItems: 'center', backgroundColor: '#f9f9f9' },
  bidText: { fontSize: 20, color: '#000' },
  bidTextActive: { fontWeight: 'bold' },
  pickerButton: { flexDirection: 'row', justifyContent: 'space-between', padding: 14, backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#a5d6a7', borderRadius: 8, alignItems: 'center' },
  pickerText: { fontSize: 18, color: '#333' },
  pickerChevron: { fontSize: 16, color: COLORS.primaryGreen },
  scoreButton: { marginTop: 12, padding: 14, backgroundColor: '#e8f5e9', borderWidth: 2, borderColor: '#0a0', borderRadius: 8, alignItems: 'center', width: '100%' },
  scoreButtonText: { fontSize: 20, fontWeight: 'bold', color: '#004d00' },
  
  reviewTitle: { fontSize: 24, fontWeight: 'bold', color: COLORS.primaryGreen, marginBottom: 15, textAlign: 'center' },
  reviewText: { fontSize: 18, color: '#333', textAlign: 'center', marginBottom: 5 },

  scorecardWindow: { width: '100%', maxWidth: 450, alignSelf: 'center', backgroundColor: COLORS.paperIvory, borderWidth: 1.5, borderColor: COLORS.inkCharcoal, borderRadius: 8, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5, elevation: 3 },
  archiveHeader: { backgroundColor: COLORS.backgroundMint, padding: 5, borderBottomWidth: 1.5, borderColor: COLORS.inkCharcoal },
  archiveHeaderText: { textAlign: 'center', fontWeight: 'bold', color: COLORS.primaryGreen, marginBottom: 5, fontSize: 16 },
  
  scorecardHeaderRow: { flexDirection: 'row', borderBottomWidth: 1.5, borderColor: COLORS.inkCharcoal, width: '100%' },
  headerCellWe: { flex: 1, alignItems: 'flex-end', paddingRight: 15, paddingVertical: 6, borderRightWidth: 1.5, borderColor: COLORS.inkCharcoal },
  headerCellThey: { flex: 1, alignItems: 'flex-start', paddingLeft: 15, paddingVertical: 6 },
  headerTitle: { fontSize: 18, fontWeight: 'bold', color: COLORS.primaryGreen },
  playerName: { fontSize: 14, color: '#0a0', textAlign: 'center', marginTop: 2 },
  vulnWrapper: { borderBottomWidth: 2, borderBottomColor: COLORS.inkCrimson, paddingBottom: 0 },
  
  scoreArea: { flexDirection: 'row', width: '100%', minHeight: 120 },
  theLine: { height: 4, backgroundColor: COLORS.inkCharcoal, width: '100%' },
  halfColumn: { flex: 1, paddingVertical: 5 },
  halfColumnThey: { flex: 1, paddingVertical: 5, borderLeftWidth: 1.5, borderColor: COLORS.inkCharcoal },
  
  scoreRow: { flexDirection: 'row', width: '100%', alignItems: 'center', marginVertical: 2 },
  scoreRowWe: { flexDirection: 'row', width: '100%' },
  scoreRowThey: { flexDirection: 'row', width: '100%' },
  
  annoContainerWe: { flex: 1, paddingLeft: 8, justifyContent: 'center', alignItems: 'flex-start' },
  annoContainerThey: { flex: 1, paddingRight: 8, justifyContent: 'center', alignItems: 'flex-end' },
  
  scoreCellWe: { paddingRight: 15, minWidth: 80, alignItems: 'flex-end' },
  scoreCellThey: { paddingLeft: 15, minWidth: 80, alignItems: 'flex-start' },
  gameLine: { borderBottomWidth: 2, borderColor: COLORS.inkCharcoal },
  
  scoreText: { fontSize: 26, lineHeight: 30, fontFamily: 'serif' }, 
  annoText: { fontSize: 15, color: '#666', lineHeight: 18, fontFamily: 'serif' },

  ledgerSummary: { backgroundColor: '#fff', borderRadius: 8, padding: 15, width: '100%', borderWidth: 1, borderColor: '#e0e0e0', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 3, elevation: 2 },
  tallyGrid: { width: '100%' },
  archiveCard: { backgroundColor: '#fff', padding: 15, borderRadius: 8, marginBottom: 10, borderWidth: 1, borderColor: '#ddd' },
  
  tabBar: { 
    flexDirection: 'row', 
    backgroundColor: COLORS.primaryGreen, 
    borderTopWidth: 1, 
    borderColor: 'rgba(255, 255, 255, 0.1)', 
    width: '100%', 
    alignItems: 'center',
    elevation: 8, 
    shadowColor: '#000', 
    shadowOffset: { width: 0, height: -2 }, 
    shadowOpacity: 0.05, 
    shadowRadius: 3 
  },
  tabItem: { 
    flex: 1, 
    alignItems: 'center', 
    justifyContent: 'center', 
    paddingVertical: 18 
  },
  tabIndicator: { 
    position: 'absolute', 
    top: -1, 
    width: '50%', 
    height: 4, 
    backgroundColor: 'transparent', 
    alignSelf: 'center',
    borderBottomLeftRadius: 4, 
    borderBottomRightRadius: 4 
  },
  tabIndicatorActive: { 
    backgroundColor: COLORS.gold 
  },
  tabLabel: { 
    fontSize: 13, 
    color: 'rgba(255, 255, 255, 0.5)', 
    fontWeight: 'bold', 
    letterSpacing: 1.5,
    textAlign: 'center'
  },
  tabLabelActive: { 
    color: COLORS.gold 
  },

  historyColumnRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center',
    paddingVertical: 2 
  },
  historyColumnName: { 
    flex: 1,
    fontSize: 16, 
    fontWeight: 'bold', 
    color: '#333' 
  },
  historyColumnScoreBox: {
    width: 80,
    alignItems: 'flex-end'
  },
  historyColumnScore: { 
    fontSize: 16, 
    fontWeight: 'bold' 
  },
  
  modalOverlayCentered: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { backgroundColor: '#fff', borderRadius: 20, padding: 20, alignItems: 'center', maxHeight: '85%', width: '90%', maxWidth: 450, alignSelf: 'center' },
  playerCard: { width: '90%', maxWidth: 450, borderRadius: 16, maxHeight: '95%', backgroundColor: '#fff', padding: 20, alignItems: 'center' },
  modalHandle: { width: 0, height: 0, display: 'none' }, 
  modalTitle: { fontSize: 20, fontWeight: 'bold', marginBottom: 15, color: COLORS.primaryGreen },
  modalOption: { width: '100%', height: 50, borderBottomWidth: 1, borderColor: '#eee', justifyContent: 'center', alignItems: 'center' },
  modalOptionText: { fontSize: 18, color: '#333' },
  modalCloseBtn: { marginTop: 20, padding: 10 },
  closeText: { fontSize: 18, color: '#666' },
  modalBtn: { width: '100%', padding: 12, backgroundColor: '#f0f0f0', borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#ccc' },
  modalBtnText: { fontSize: 18, fontWeight: 'bold', color: '#333' },
  settingsDangerBtn: { padding: 12, borderColor: '#d32f2f', backgroundColor: '#ffebee', borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  dangerBtnText: { color: '#d32f2f', fontWeight: 'bold', fontSize: 16, textAlign: 'center' },
  
  inputRow: { flexDirection: 'row', width: '100%', marginBottom: 10 },
  inputCol: { flex: 1, alignItems: 'center', paddingHorizontal: 5 },
  inputLabel: { fontWeight: 'bold', color: COLORS.primaryGreen, marginBottom: 10 },
  input: { width: '100%', borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 16, textAlign: 'center' },
  focusedInput: { borderColor: '#0a0' },
  chipBox: { width: '100%', marginBottom: 15, alignItems: 'center' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6 },
  nameChip: { backgroundColor: '#4caf50', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, margin: 3 },
  settingRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 15, borderBottomWidth: 1, borderColor: '#eee', width: '100%' },
  settingText: { fontSize: 18, color: '#333' },
  subCloseText: { fontSize: 16, color: '#666', textAlign: 'center' },
  emptyVaultText: { textAlign: 'center', color: '#666', marginTop: 20 },
  vaultCardDate: { fontWeight: 'bold', color: COLORS.primaryGreen, fontSize: 16, marginBottom: 5 },
  vaultHeaderCard: { width: '100%', padding: 15, backgroundColor: '#fff', borderRadius: 8, marginBottom: 15, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 3, elevation: 2, maxWidth: 450, alignSelf: 'center' },
  vaultDateText: { fontWeight: 'bold', fontSize: 18, color: COLORS.primaryGreen },
  vaultSummaryLine: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderColor: '#eee' },
  vaultActionBar: { padding: 15, backgroundColor: '#fff', borderTopWidth: 1, borderColor: '#ccc', flexDirection: 'row', gap: 10 }
});
