
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Region, Aquifer, RasterAnalysisMeta, ImputationModelMeta } from '../types';
import { MapPin, Droplets, MoreVertical, Pencil, Trash2, Download, Layers, Loader2, Info, Check, X as XIcon, ChevronRight, ChevronDown, Activity, Eye, EyeOff } from 'lucide-react';

interface SidebarProps {
  regions: Region[];
  selectedRegion: Region | null;
  setSelectedRegion: (r: Region | null) => void;
  allAquifers: Aquifer[];
  selectedAquifer: Aquifer | null;
  setSelectedAquifer: (a: Aquifer | null) => void;
  visibleRegionIds: Set<string>;
  onToggleRegionVisibility: (id: string) => void;
  onEditRegion: (id: string, newName: string, lengthUnit: 'ft' | 'm') => void;
  onDownloadRegion: (id: string) => void;
  onDeleteRegion: (id: string) => void | Promise<void>;
  onRenameAquifer: (id: string, newName: string) => void;
  onDeleteAquifer: (id: string) => void;
  rasterMeta: RasterAnalysisMeta[];
  activeRasterCode: string | null;
  compareRasterCodes: string[];
  loadingRasterCode: string | null;
  onLoadRaster: (meta: RasterAnalysisMeta) => void;
  onUnloadRaster: () => void;
  onToggleCompareRaster: (meta: RasterAnalysisMeta) => void;
  onDeleteRaster: (meta: RasterAnalysisMeta) => void;
  onRenameRaster?: (meta: RasterAnalysisMeta, newTitle: string) => void;
  onGetRasterInfo?: (meta: RasterAnalysisMeta) => void;
  modelMeta: ImputationModelMeta[];
  activeModelCode: string | null;
  loadingModelCode: string | null;
  onLoadModel: (meta: ImputationModelMeta) => void;
  onUnloadModel: () => void;
  onDeleteModel: (meta: ImputationModelMeta) => void;
  onRenameModel?: (meta: ImputationModelMeta, newTitle: string) => void;
  onGetModelInfo?: (meta: ImputationModelMeta) => void;
}

// Globally unique identity for raster/model entries. Codes alone collide
// across aquifers — every basin's default kriging raster is "wte_kriging",
// so a code-only active check lit up (and toggled) all of them at once.
export const rasterMetaKey = (m: RasterAnalysisMeta) => `${m.regionId}:${m.aquiferId}:${m.dataType}_${m.code}`;
export const modelMetaKey = (m: ImputationModelMeta) => `${m.regionId}:${m.aquiferId}:${m.code}`;

type TreeItemType = 'region' | 'aquifer' | 'raster' | 'model';
interface TreeItem {
  key: string;
  type: TreeItemType;
  regionId: string;
  aquiferId?: string;
  rasterCode?: string;
  rasterDataType?: string;
  modelCode?: string;
}

const Sidebar: React.FC<SidebarProps> = ({
  regions,
  selectedRegion,
  setSelectedRegion,
  allAquifers,
  selectedAquifer,
  setSelectedAquifer,
  visibleRegionIds,
  onToggleRegionVisibility,
  onEditRegion,
  onDownloadRegion,
  onDeleteRegion,
  onRenameAquifer,
  onDeleteAquifer,
  rasterMeta,
  activeRasterCode,
  compareRasterCodes,
  loadingRasterCode,
  onLoadRaster,
  onUnloadRaster,
  onToggleCompareRaster,
  onDeleteRaster,
  onRenameRaster,
  onGetRasterInfo,
  modelMeta,
  activeModelCode,
  loadingModelCode,
  onLoadModel,
  onUnloadModel,
  onDeleteModel,
  onRenameModel,
  onGetModelInfo,
}) => {
  // --- State ---
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editUnit, setEditUnit] = useState<'ft' | 'm'>('ft');


  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [expandedRegionIds, setExpandedRegionIds] = useState<Set<string>>(new Set());
  const [expandedAquiferIds, setExpandedAquiferIds] = useState<Set<string>>(new Set());
  const [lastActiveRasterByAquifer, setLastActiveRasterByAquifer] = useState<Map<string, string>>(new Map());
  const [focusedItemKey, setFocusedItemKey] = useState<string | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const editModalRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  // --- Derived data ---
  const aquifersByRegion = useMemo(() => {
    const map = new Map<string, Aquifer[]>();
    for (const a of allAquifers) {
      const list = map.get(a.regionId) || [];
      list.push(a);
      map.set(a.regionId, list);
    }
    return map;
  }, [allAquifers]);

  const rastersByAquifer = useMemo(() => {
    const map = new Map<string, RasterAnalysisMeta[]>();
    for (const m of rasterMeta) {
      const key = `${m.regionId}:${m.aquiferId}`;
      const list = map.get(key) || [];
      list.push(m);
      map.set(key, list);
    }
    return map;
  }, [rasterMeta]);

  const modelsByAquifer = useMemo(() => {
    const map = new Map<string, ImputationModelMeta[]>();
    for (const m of modelMeta) {
      const key = `${m.regionId}:${m.aquiferId}`;
      const list = map.get(key) || [];
      list.push(m);
      map.set(key, list);
    }
    return map;
  }, [modelMeta]);

  // Region-level lookups for single-unit regions, where rasters/models render
  // directly under the region (the aquifer level is hidden by design).
  const rastersByRegion = useMemo(() => {
    const map = new Map<string, RasterAnalysisMeta[]>();
    for (const m of rasterMeta) {
      const list = map.get(m.regionId) || [];
      list.push(m);
      map.set(m.regionId, list);
    }
    return map;
  }, [rasterMeta]);

  const modelsByRegion = useMemo(() => {
    const map = new Map<string, ImputationModelMeta[]>();
    for (const m of modelMeta) {
      const list = map.get(m.regionId) || [];
      list.push(m);
      map.set(m.regionId, list);
    }
    return map;
  }, [modelMeta]);

  // --- Flat items for keyboard nav ---
  const flatItems = useMemo(() => {
    const items: TreeItem[] = [];
    for (const r of regions) {
      items.push({ key: `region-${r.id}`, type: 'region', regionId: r.id });
      if (!expandedRegionIds.has(r.id)) continue;
      if (r.singleUnit) {
        // Rasters/models render directly under the region (no aquifer row).
        const rasters = rastersByRegion.get(r.id) || [];
        for (const m of rasters) {
          items.push({ key: `raster-${m.regionId}-${m.aquiferId}-${m.dataType}_${m.code}`, type: 'raster', regionId: r.id, aquiferId: m.aquiferId, rasterCode: m.code, rasterDataType: m.dataType });
        }
        const models = modelsByRegion.get(r.id) || [];
        for (const m of models) {
          items.push({ key: `model-${m.regionId}-${m.aquiferId}-${m.code}`, type: 'model', regionId: r.id, aquiferId: m.aquiferId, modelCode: m.code });
        }
        continue;
      }
      const regionAquifers = aquifersByRegion.get(r.id) || [];
      for (const a of regionAquifers) {
        items.push({ key: `aquifer-${a.id}`, type: 'aquifer', regionId: r.id, aquiferId: a.id });
        if (expandedAquiferIds.has(a.id)) {
          const rasters = rastersByAquifer.get(`${r.id}:${a.id}`) || [];
          for (const m of rasters) {
            items.push({ key: `raster-${m.regionId}-${m.aquiferId}-${m.dataType}_${m.code}`, type: 'raster', regionId: r.id, aquiferId: a.id, rasterCode: m.code, rasterDataType: m.dataType });
          }
          const models = modelsByAquifer.get(`${r.id}:${a.id}`) || [];
          for (const m of models) {
            items.push({ key: `model-${m.regionId}-${m.aquiferId}-${m.code}`, type: 'model', regionId: r.id, aquiferId: a.id, modelCode: m.code });
          }
        }
      }
    }
    return items;
  }, [regions, expandedRegionIds, expandedAquiferIds, aquifersByRegion, rastersByAquifer, modelsByAquifer, rastersByRegion, modelsByRegion]);

  // --- Effects ---

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Focus input when editing starts
  useEffect(() => {
    if (editing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editing]);

  // External selection sync: auto-expand when selection changes from outside (e.g. map clicks)
  useEffect(() => {
    if (selectedRegion) {
      setExpandedRegionIds(prev => {
        if (prev.has(selectedRegion.id)) return prev;
        const next = new Set<string>();
        next.add(selectedRegion.id);
        return next;
      });
    }
  }, [selectedRegion?.id]);

  useEffect(() => {
    if (selectedAquifer) {
      setExpandedAquiferIds(prev => {
        if (prev.has(selectedAquifer.id)) return prev;
        const next = new Set<string>();
        next.add(selectedAquifer.id);
        return next;
      });
    }
  }, [selectedAquifer?.id]);

  // Track last-active raster per aquifer
  useEffect(() => {
    if (activeRasterCode) {
      const meta = rasterMeta.find(m => rasterMetaKey(m) === activeRasterCode);
      if (meta) {
        setLastActiveRasterByAquifer(prev => {
          const next = new Map(prev);
          next.set(`${meta.regionId}:${meta.aquiferId}`, rasterMetaKey(meta));
          return next;
        });
      }
    }
  }, [activeRasterCode, rasterMeta]);

  // --- Helpers ---
  const startEditRegion = (id: string, region: Region) => {
    setMenuOpen(null);
    setEditing(`region-${id}`);
    setEditValue(region.name);
    setEditUnit(region.lengthUnit);
  };

  const startEditAquifer = (id: string, currentName: string) => {
    setMenuOpen(null);
    setEditing(`aquifer-${id}`);
    setEditValue(currentName);
  };

  const confirmEditRegion = (id: string) => {
    const trimmed = editValue.trim();
    if (trimmed) {
      const region = regions.find(r => r.id === id);
      if (trimmed !== region?.name || editUnit !== region?.lengthUnit) {
        onEditRegion(id, trimmed, editUnit);
      }
    }
    setEditing(null);
  };

  const confirmEditAquifer = (id: string) => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== allAquifers.find(a => a.id === id)?.name) {
      onRenameAquifer(id, trimmed);
    }
    setEditing(null);
  };

  const startDelete = (id: string) => {
    setMenuOpen(null);
    setConfirmDelete(id);
  };

  const handleRegionClick = useCallback((r: Region) => {
    const isSelected = selectedRegion?.id === r.id;
    if (isSelected) {
      setSelectedRegion(null);
      setExpandedRegionIds(prev => {
        const next = new Set(prev);
        next.delete(r.id);
        return next;
      });
    } else {
      setSelectedRegion(r);
      // Accordion: expand this, collapse others
      setExpandedRegionIds(new Set([r.id]));
    }
  }, [selectedRegion, setSelectedRegion]);

  const handleRegionChevronClick = useCallback((regionId: string) => {
    setExpandedRegionIds(prev => {
      const next = new Set(prev);
      if (next.has(regionId)) next.delete(regionId);
      else next.add(regionId);
      return next;
    });
  }, []);

  const handleAquiferClick = useCallback((a: Aquifer) => {
    const isSelected = selectedAquifer?.id === a.id;
    if (isSelected) {
      setSelectedAquifer(null);
      setExpandedAquiferIds(prev => {
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    } else {
      // Switch to the parent region if needed so the map/data view follows
      if (selectedRegion?.id !== a.regionId) {
        const parent = regions.find(r => r.id === a.regionId);
        if (parent) {
          if (!visibleRegionIds.has(parent.id)) onToggleRegionVisibility(parent.id);
          setSelectedRegion(parent);
          setExpandedRegionIds(new Set([parent.id]));
        }
      }
      setSelectedAquifer(a);
      // Accordion: expand this, collapse sibling aquifers
      const rasters = rastersByAquifer.get(`${a.regionId}:${a.id}`) || [];
      const models = modelsByAquifer.get(`${a.regionId}:${a.id}`) || [];
      const hasChildren = rasters.length > 0 || models.length > 0;
      setExpandedAquiferIds(hasChildren ? new Set([a.id]) : new Set());
      // Restore last-active raster if none active
      if (!activeRasterCode && rasters.length > 0) {
        const lastKey = lastActiveRasterByAquifer.get(`${a.regionId}:${a.id}`);
        if (lastKey) {
          const meta = rasters.find(m => rasterMetaKey(m) === lastKey);
          if (meta) onLoadRaster(meta);
        }
      }
    }
  }, [selectedAquifer, setSelectedAquifer, selectedRegion, setSelectedRegion, regions, visibleRegionIds, onToggleRegionVisibility, rastersByAquifer, modelsByAquifer, activeRasterCode, lastActiveRasterByAquifer, onLoadRaster]);

  const handleAquiferChevronClick = useCallback((aquiferId: string) => {
    setExpandedAquiferIds(prev => {
      const next = new Set(prev);
      if (next.has(aquiferId)) next.delete(aquiferId);
      else next.add(aquiferId);
      return next;
    });
  }, []);

  // --- Keyboard navigation ---
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!flatItems.length) return;
    const idx = focusedItemKey ? flatItems.findIndex(i => i.key === focusedItemKey) : -1;

    const focusItem = (newIdx: number) => {
      const item = flatItems[newIdx];
      if (item) {
        setFocusedItemKey(item.key);
        const el = treeRef.current?.querySelector(`[data-item-key="${item.key}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      }
    };

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusItem(Math.min(idx + 1, flatItems.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusItem(Math.max(idx - 1, 0));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (idx < 0) return;
      const item = flatItems[idx];
      if (item.type === 'region') {
        if (expandedRegionIds.has(item.regionId)) {
          // Already expanded, move to first child (aquifer, or raster/model for single-unit)
          if (idx + 1 < flatItems.length && flatItems[idx + 1].regionId === item.regionId && flatItems[idx + 1].type !== 'region') {
            focusItem(idx + 1);
          }
        } else {
          handleRegionChevronClick(item.regionId);
        }
      } else if (item.type === 'aquifer') {
        if (expandedAquiferIds.has(item.aquiferId!)) {
          if (idx + 1 < flatItems.length && flatItems[idx + 1].type === 'raster') {
            focusItem(idx + 1);
          }
        } else {
          handleAquiferChevronClick(item.aquiferId!);
        }
      }
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (idx < 0) return;
      const item = flatItems[idx];
      if (item.type === 'region') {
        if (expandedRegionIds.has(item.regionId)) {
          handleRegionChevronClick(item.regionId);
        }
      } else if (item.type === 'aquifer') {
        if (expandedAquiferIds.has(item.aquiferId!)) {
          handleAquiferChevronClick(item.aquiferId!);
        } else {
          // Move to parent region
          const parentIdx = flatItems.findIndex(i => i.key === `region-${item.regionId}`);
          if (parentIdx >= 0) focusItem(parentIdx);
        }
      } else if (item.type === 'raster' || item.type === 'model') {
        // Move to parent aquifer
        const parentIdx = flatItems.findIndex(i => i.key === `aquifer-${item.aquiferId}`);
        if (parentIdx >= 0) focusItem(parentIdx);
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (idx < 0) return;
      const item = flatItems[idx];
      if (item.type === 'region') {
        const r = regions.find(rr => rr.id === item.regionId);
        if (r) handleRegionClick(r);
      } else if (item.type === 'aquifer') {
        const a = allAquifers.find(aa => aa.id === item.aquiferId);
        if (a) handleAquiferClick(a);
      } else if (item.type === 'raster') {
        const m = rasterMeta.find(mm => mm.code === item.rasterCode && mm.dataType === item.rasterDataType && mm.regionId === item.regionId && (!item.aquiferId || mm.aquiferId === item.aquiferId));
        if (m) {
          if (activeRasterCode === rasterMetaKey(m)) {
            onUnloadRaster();
          } else {
            onLoadRaster(m);
          }
        }
      } else if (item.type === 'model') {
        const m = modelMeta.find(mm => mm.code === item.modelCode && mm.regionId === item.regionId && (!item.aquiferId || mm.aquiferId === item.aquiferId));
        if (m) {
          if (activeModelCode === modelMetaKey(m)) {
            onUnloadModel();
          } else {
            onLoadModel(m);
          }
        }
      }
    }
  }, [flatItems, focusedItemKey, expandedRegionIds, expandedAquiferIds, regions, allAquifers, rasterMeta, activeRasterCode, modelMeta, activeModelCode, handleRegionClick, handleAquiferClick, handleRegionChevronClick, handleAquiferChevronClick, onLoadRaster, onUnloadRaster, onLoadModel, onUnloadModel]);

  // --- Render helpers ---

  const renderRasterRow = (m: RasterAnalysisMeta) => {
    const rasterKey = `${m.dataType}_${m.code}`;
    const isActive = activeRasterCode === rasterMetaKey(m);
    const isCompare = compareRasterCodes.includes(rasterMetaKey(m));
    const isLoading = loadingRasterCode === m.code;
    const rasterMenuKey = `raster-${m.regionId}-${m.aquiferId}-${rasterKey}`;
    const isRasterMenuOpen = menuOpen === rasterMenuKey;
    const isRasterConfirming = confirmDelete === rasterMenuKey;
    const isRasterEditing = editing === `raster-${m.regionId}-${m.aquiferId}-${rasterKey}`;
    const itemKey = `raster-${m.regionId}-${m.aquiferId}-${rasterKey}`;
    const isFocused = focusedItemKey === itemKey;
    const displayTitle = `${m.dataType}_${m.title}`;

    if (isRasterConfirming) {
      return (
        <div key={rasterKey} className="pl-16 pr-2 py-1" data-item-key={itemKey}>
          <div className="px-2 py-1.5 rounded bg-red-50 border border-red-200 text-xs">
            <p className="text-red-700 font-medium mb-1.5">Delete "{displayTitle}"?</p>
            <div className="flex space-x-2">
              <button
                onClick={() => { onDeleteRaster(m); setConfirmDelete(null); }}
                className="px-2 py-0.5 bg-red-600 text-white rounded text-[10px] font-medium hover:bg-red-700"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-2 py-0.5 bg-white text-slate-600 rounded text-[10px] font-medium border border-slate-200 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (isRasterEditing) {
      return (
        <div key={rasterKey} className="pl-16 pr-2 flex items-center gap-1 py-1" data-item-key={itemKey}>
          <input
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const trimmed = editValue.trim();
                if (trimmed && trimmed !== m.title && onRenameRaster) {
                  onRenameRaster(m, trimmed);
                }
                setEditing(null);
              }
              if (e.key === 'Escape') setEditing(null);
            }}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border border-emerald-400 rounded outline-none focus:ring-2 focus:ring-emerald-300"
          />
          <button
            onClick={() => {
              const trimmed = editValue.trim();
              if (trimmed && trimmed !== m.title && onRenameRaster) {
                onRenameRaster(m, trimmed);
              }
              setEditing(null);
            }}
            className="p-0.5 text-emerald-600 hover:bg-emerald-50 rounded"
          >
            <Check size={12} />
          </button>
          <button
            onClick={() => setEditing(null)}
            className="p-0.5 text-slate-400 hover:bg-slate-100 rounded"
          >
            <XIcon size={12} />
          </button>
        </div>
      );
    }

    return (
      <div
        key={rasterKey}
        className="relative group/raster"
        data-item-key={itemKey}
      >
        <div className={`flex items-center pl-16 pr-2 rounded transition-colors ${
          isFocused ? 'ring-2 ring-inset ring-blue-400' : ''
        } ${
          isActive
            ? 'bg-emerald-50'
            : isCompare
              ? 'bg-blue-50'
              : 'hover:bg-slate-50'
        }`}>
          <button
            onClick={(e) => {
              setFocusedItemKey(itemKey);
              if (e.shiftKey && activeRasterCode) {
                onToggleCompareRaster(m);
              } else if (isActive) {
                onUnloadRaster();
              } else {
                onLoadRaster(m);
              }
            }}
            className={`flex-1 text-left pr-1 py-1.5 text-xs flex items-center gap-2 min-w-0 ${
              isActive
                ? 'text-emerald-700 font-medium'
                : isCompare
                  ? 'text-blue-700 font-medium'
                  : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {isLoading
              ? <Loader2 size={12} className="flex-shrink-0 animate-spin" />
              : <Layers size={12} className={`flex-shrink-0 ${isActive ? 'text-emerald-500' : isCompare ? 'text-blue-500' : 'text-slate-300'}`} />}
            <span className="truncate">{displayTitle}</span>
            {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />}
            {isCompare && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 flex-shrink-0" />}
          </button>
          <div
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(isRasterMenuOpen ? null : rasterMenuKey);
              setConfirmDelete(null);
            }}
            className={`p-0.5 rounded mr-1 flex-shrink-0 opacity-0 group-hover/raster:opacity-100 transition-opacity cursor-pointer hover:bg-slate-200 ${
              isRasterMenuOpen ? 'opacity-100' : ''
            }`}
          >
            <MoreVertical size={12} />
          </div>
        </div>
        {isRasterMenuOpen && (
          <div ref={menuRef} className="absolute right-1 top-full mt-0.5 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[100px]">
            {onRenameRaster && (
              <button
                onClick={() => {
                  setMenuOpen(null);
                  setEditing(`raster-${m.regionId}-${m.aquiferId}-${rasterKey}`);
                  setEditValue(m.title);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Pencil size={11} />
                <span>Edit</span>
              </button>
            )}
            {onGetRasterInfo && (
              <button
                onClick={() => { setMenuOpen(null); onGetRasterInfo(m); }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Info size={11} />
                <span>Get Info</span>
              </button>
            )}
            <button
              onClick={() => { setMenuOpen(null); setConfirmDelete(rasterMenuKey); }}
              className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center space-x-2"
            >
              <Trash2 size={11} />
              <span>Delete</span>
            </button>
          </div>
        )}
        {/* Hover metadata tooltip */}
        <div className="absolute left-full ml-2 top-0 hidden group-hover/raster:block z-[60] pointer-events-none">
          <div className="bg-slate-800 text-white text-[11px] rounded-lg p-3 shadow-xl min-w-[220px] leading-relaxed">
            <div className="font-semibold text-emerald-300 mb-1.5">{displayTitle}</div>
            <div><span className="text-slate-400">Dates:</span> {m.params.startDate} &mdash; {m.params.endDate}</div>
            <div><span className="text-slate-400">Interval:</span> {m.params.interval}</div>
            <div><span className="text-slate-400">Resolution:</span> {m.params.resolution}</div>
            <div><span className="text-slate-400">Data Type:</span> {m.dataType.toUpperCase()}</div>
            <div className="mt-1.5 text-slate-400 text-[10px]">Created {new Date(m.createdAt).toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    );
  };

  const renderModelRow = (m: ImputationModelMeta) => {
    const isActive = activeModelCode === modelMetaKey(m);
    const isModelLoading = loadingModelCode === m.code;
    const modelMenuKey = `model-${m.regionId}-${m.aquiferId}-${m.code}`;
    const isModelMenuOpen = menuOpen === modelMenuKey;
    const isModelConfirming = confirmDelete === modelMenuKey;
    const isModelEditing = editing === `model-${m.regionId}-${m.aquiferId}-${m.code}`;
    const itemKey = `model-${m.regionId}-${m.aquiferId}-${m.code}`;
    const isFocused = focusedItemKey === itemKey;

    if (isModelConfirming) {
      return (
        <div key={`model-${m.code}`} className="pl-16 pr-2 py-1" data-item-key={itemKey}>
          <div className="px-2 py-1.5 rounded bg-red-50 border border-red-200 text-xs">
            <p className="text-red-700 font-medium mb-1.5">Delete "{m.title}"?</p>
            <div className="flex space-x-2">
              <button
                onClick={() => { onDeleteModel(m); setConfirmDelete(null); }}
                className="px-2 py-0.5 bg-red-600 text-white rounded text-[10px] font-medium hover:bg-red-700"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-2 py-0.5 bg-white text-slate-600 rounded text-[10px] font-medium border border-slate-200 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (isModelEditing) {
      return (
        <div key={`model-${m.code}`} className="pl-16 pr-2 flex items-center gap-1 py-1" data-item-key={itemKey}>
          <input
            autoFocus
            value={editValue}
            onChange={e => setEditValue(e.target.value.replace(/[^a-zA-Z0-9 _-]/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                const trimmed = editValue.trim();
                if (trimmed && trimmed !== m.title && onRenameModel) {
                  onRenameModel(m, trimmed);
                }
                setEditing(null);
              }
              if (e.key === 'Escape') setEditing(null);
            }}
            className="flex-1 min-w-0 px-1.5 py-0.5 text-xs border border-amber-400 rounded outline-none focus:ring-2 focus:ring-amber-300"
          />
          <button
            onClick={() => {
              const trimmed = editValue.trim();
              if (trimmed && trimmed !== m.title && onRenameModel) {
                onRenameModel(m, trimmed);
              }
              setEditing(null);
            }}
            className="p-0.5 text-amber-600 hover:bg-amber-50 rounded"
          >
            <Check size={12} />
          </button>
          <button
            onClick={() => setEditing(null)}
            className="p-0.5 text-slate-400 hover:bg-slate-100 rounded"
          >
            <XIcon size={12} />
          </button>
        </div>
      );
    }

    return (
      <div
        key={`model-${m.code}`}
        className="relative group/model"
        data-item-key={itemKey}
      >
        <div className={`flex items-center pl-16 pr-2 rounded transition-colors ${
          isFocused ? 'ring-2 ring-inset ring-blue-400' : ''
        } ${
          isActive ? 'bg-amber-50' : 'hover:bg-slate-50'
        }`}>
          <button
            onClick={() => {
              setFocusedItemKey(itemKey);
              if (isActive) {
                onUnloadModel();
              } else {
                onLoadModel(m);
              }
            }}
            className={`flex-1 text-left pr-1 py-1.5 text-xs flex items-center gap-2 min-w-0 ${
              isActive
                ? 'text-amber-700 font-medium'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {isModelLoading
              ? <Loader2 size={12} className="flex-shrink-0 animate-spin" />
              : <Activity size={12} className={`flex-shrink-0 ${isActive ? 'text-amber-500' : 'text-slate-300'}`} />}
            <span className="truncate">{m.title}</span>
            {isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />}
          </button>
          <div
            onClick={e => {
              e.stopPropagation();
              setMenuOpen(isModelMenuOpen ? null : modelMenuKey);
              setConfirmDelete(null);
            }}
            className={`p-0.5 rounded mr-1 flex-shrink-0 opacity-0 group-hover/model:opacity-100 transition-opacity cursor-pointer hover:bg-slate-200 ${
              isModelMenuOpen ? 'opacity-100' : ''
            }`}
          >
            <MoreVertical size={12} />
          </div>
        </div>
        {isModelMenuOpen && (
          <div ref={menuRef} className="absolute right-1 top-full mt-0.5 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[100px]">
            {onRenameModel && (
              <button
                onClick={() => {
                  setMenuOpen(null);
                  setEditing(`model-${m.regionId}-${m.aquiferId}-${m.code}`);
                  setEditValue(m.title);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Pencil size={11} />
                <span>Edit</span>
              </button>
            )}
            {onGetModelInfo && (
              <button
                onClick={() => { setMenuOpen(null); onGetModelInfo(m); }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Info size={11} />
                <span>Get Info</span>
              </button>
            )}
            <button
              onClick={() => { setMenuOpen(null); setConfirmDelete(modelMenuKey); }}
              className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center space-x-2"
            >
              <Trash2 size={11} />
              <span>Delete</span>
            </button>
          </div>
        )}
        {/* Hover metadata tooltip */}
        <div className="absolute left-full ml-2 top-0 hidden group-hover/model:block z-[60] pointer-events-none">
          <div className="bg-slate-800 text-white text-[11px] rounded-lg p-3 shadow-xl min-w-[220px] leading-relaxed">
            <div className="font-semibold text-amber-300 mb-1.5">{m.title}</div>
            <div><span className="text-slate-400">Dates:</span> {m.params.startDate} &mdash; {m.params.endDate}</div>
            <div><span className="text-slate-400">Gap Size:</span> {m.params.gapSize} months</div>
            <div><span className="text-slate-400">Wells Modeled:</span> {Object.keys(m.wellMetrics).length}</div>
            <div className="mt-1.5 text-slate-400 text-[10px]">Created {new Date(m.createdAt).toLocaleDateString()}</div>
          </div>
        </div>
      </div>
    );
  };

  const renderAquiferRow = (a: Aquifer, regionId: string) => {
    const isSelected = selectedAquifer?.id === a.id;
    const isEditing = editing === `aquifer-${a.id}`;
    const isConfirming = confirmDelete === `aquifer-${a.id}`;
    const isMenuOpen = menuOpen === `aquifer-${a.id}`;
    const rasters = rastersByAquifer.get(`${regionId}:${a.id}`) || [];
    const models = modelsByAquifer.get(`${regionId}:${a.id}`) || [];
    const hasChildren = rasters.length > 0 || models.length > 0;
    const hasRasters = rasters.length > 0;
    const isExpanded = expandedAquiferIds.has(a.id);
    const itemKey = `aquifer-${a.id}`;
    const isFocused = focusedItemKey === itemKey;

    if (isConfirming) {
      return (
        <div key={a.id} data-item-key={itemKey}>
          <div className="pl-6 pr-2 py-1">
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs">
              <p className="text-red-700 font-medium mb-2">Delete "{a.name}" and its wells?</p>
              <div className="flex space-x-2">
                <button
                  onClick={() => { onDeleteAquifer(a.id); setConfirmDelete(null); }}
                  className="px-3 py-1 bg-red-600 text-white rounded text-[10px] font-medium hover:bg-red-700"
                >
                  Yes, delete
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="px-3 py-1 bg-white text-slate-600 rounded text-[10px] font-medium border border-slate-200 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={a.id} data-item-key={itemKey}>
        <div className="relative">
          <button
            onClick={() => {
              if (!isEditing) {
                setFocusedItemKey(itemKey);
                handleAquiferClick(a);
              }
            }}
            className={`w-full text-left pl-6 pr-2 py-1.5 text-xs transition-all flex items-center group ${
              isFocused ? 'ring-2 ring-inset ring-blue-400' : ''
            } ${
              isSelected
                ? 'bg-indigo-500 text-white'
                : 'text-slate-600 hover:bg-slate-50 hover:text-indigo-500'
            }`}
          >
            {/* Chevron */}
            {hasChildren && !isEditing ? (
              <div
                onClick={e => {
                  e.stopPropagation();
                  handleAquiferChevronClick(a.id);
                }}
                className={`w-4 h-4 flex items-center justify-center flex-shrink-0 mr-1 rounded cursor-pointer transition-colors ${
                  isSelected ? 'hover:bg-indigo-400' : 'hover:bg-slate-200'
                }`}
              >
                {isExpanded
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />}
              </div>
            ) : (
              <div className="w-4 h-4 flex-shrink-0 mr-1" />
            )}
            <Droplets size={12} className={`mr-2 flex-shrink-0 ${isSelected ? 'text-indigo-200' : 'text-slate-300'}`} />
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <input
                  ref={editInputRef}
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') confirmEditAquifer(a.id);
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  onBlur={() => confirmEditAquifer(a.id)}
                  onClick={e => e.stopPropagation()}
                  className="bg-white text-slate-800 border border-indigo-400 rounded px-1.5 py-0.5 text-xs font-medium w-full outline-none focus:ring-2 focus:ring-indigo-300"
                />
              ) : (
                <span className="font-medium truncate block">{a.name}</span>
              )}
            </div>
            {!isEditing && (
              <div
                onClick={e => {
                  e.stopPropagation();
                  setMenuOpen(isMenuOpen ? null : `aquifer-${a.id}`);
                  setConfirmDelete(null);
                }}
                className={`p-0.5 rounded ml-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${
                  isSelected ? 'hover:bg-indigo-400' : 'hover:bg-slate-200'
                } ${isMenuOpen ? 'opacity-100' : ''}`}
              >
                <MoreVertical size={12} />
              </div>
            )}
          </button>
          {isMenuOpen && (
            <div ref={menuRef} className="absolute right-2 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[120px]">
              <button
                onClick={() => startEditAquifer(a.id, a.name)}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Pencil size={12} />
                <span>Rename</span>
              </button>
              <button
                onClick={() => startDelete(`aquifer-${a.id}`)}
                className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center space-x-2"
              >
                <Trash2 size={12} />
                <span>Delete</span>
              </button>
            </div>
          )}
        </div>
        {/* Raster & Model children */}
        {isExpanded && hasChildren && (
          <div className="space-y-0">
            {rasters.map(m => renderRasterRow(m))}
            {models.map(m => renderModelRow(m))}
          </div>
        )}
      </div>
    );
  };

  const renderRegionRow = (r: Region) => {
    const isSelected = selectedRegion?.id === r.id;
    const isConfirming = confirmDelete === `region-${r.id}`;
    const isMenuOpen = menuOpen === `region-${r.id}`;
    const regionAquifers = aquifersByRegion.get(r.id) || [];
    const regionRasters = r.singleUnit ? (rastersByRegion.get(r.id) || []) : [];
    const regionModels = r.singleUnit ? (modelsByRegion.get(r.id) || []) : [];
    const hasChildren = r.singleUnit
      ? (regionRasters.length > 0 || regionModels.length > 0)
      : regionAquifers.length > 0;
    const isExpanded = expandedRegionIds.has(r.id);
    const itemKey = `region-${r.id}`;
    const isFocused = focusedItemKey === itemKey;

    const isDeletingThis = deletingKey === `region-${r.id}`;
    if (isConfirming || isDeletingThis) {
      return (
        <div key={r.id} data-item-key={itemKey}>
          <div className="px-2 py-1">
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs">
              {isDeletingThis ? (
                <p className="text-red-700 font-medium flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" />
                  Deleting "{r.name}"…
                </p>
              ) : (
                <>
                  <p className="text-red-700 font-medium mb-2">Delete "{r.name}" and all its data?</p>
                  <div className="flex space-x-2">
                    <button
                      onClick={async () => {
                        setDeletingKey(`region-${r.id}`);
                        setConfirmDelete(null);
                        try {
                          await onDeleteRegion(r.id);
                        } finally {
                          setDeletingKey(null);
                        }
                      }}
                      className="px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700"
                    >
                      Yes, delete
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="px-3 py-1 bg-white text-slate-600 rounded text-xs font-medium border border-slate-200 hover:bg-slate-50"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div key={r.id} data-item-key={itemKey}>
        <div className="relative">
          <button
            onClick={() => {
              setFocusedItemKey(itemKey);
              if (!visibleRegionIds.has(r.id)) onToggleRegionVisibility(r.id);
              handleRegionClick(r);
            }}
            className={`w-full text-left px-2 py-1.5 text-xs transition-all flex items-center group ${
              isFocused ? 'ring-2 ring-inset ring-blue-400' : ''
            } ${
              isSelected
                ? 'bg-blue-600 text-white'
                : visibleRegionIds.has(r.id)
                  ? 'text-slate-600 hover:bg-slate-50 hover:text-blue-600'
                  : 'text-slate-300 hover:bg-slate-50 hover:text-blue-600'
            }`}
          >
            {/* Chevron */}
            {hasChildren ? (
              <div
                onClick={e => {
                  e.stopPropagation();
                  handleRegionChevronClick(r.id);
                }}
                className={`w-4 h-4 flex items-center justify-center flex-shrink-0 mr-1 rounded cursor-pointer transition-colors ${
                  isSelected ? 'hover:bg-blue-500' : 'hover:bg-slate-200'
                }`}
              >
                {isExpanded
                  ? <ChevronDown size={12} />
                  : <ChevronRight size={12} />}
              </div>
            ) : (
              <div className="w-4 h-4 flex-shrink-0 mr-1" />
            )}
            <MapPin size={12} className={`mr-2 flex-shrink-0 ${isSelected ? 'text-blue-200' : 'text-slate-300'}`} />
            <span className="font-medium truncate flex-1">{r.name}</span>
            <div
              onClick={e => {
                e.stopPropagation();
                setMenuOpen(isMenuOpen ? null : `region-${r.id}`);
                setConfirmDelete(null);
              }}
              className={`p-0.5 rounded flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer ${
                isSelected ? 'hover:bg-blue-500' : 'hover:bg-slate-200'
              } ${isMenuOpen ? 'opacity-100' : ''}`}
            >
              <MoreVertical size={12} />
            </div>
          </button>
          {isMenuOpen && (
            <div ref={menuRef} className="absolute right-2 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 py-1 min-w-[120px]">
              <button
                onClick={() => startEditRegion(r.id, r)}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Pencil size={12} />
                <span>Edit</span>
              </button>
              <button
                onClick={() => { onToggleRegionVisibility(r.id); setMenuOpen(null); }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                {visibleRegionIds.has(r.id) ? <EyeOff size={12} /> : <Eye size={12} />}
                <span>{visibleRegionIds.has(r.id) ? 'Hide Region' : 'Show Region'}</span>
              </button>
              <button
                onClick={() => { setMenuOpen(null); onDownloadRegion(r.id); }}
                className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center space-x-2"
              >
                <Download size={12} />
                <span>Download</span>
              </button>
              <button
                onClick={() => startDelete(`region-${r.id}`)}
                className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 flex items-center space-x-2"
              >
                <Trash2 size={12} />
                <span>Delete</span>
              </button>
            </div>
          )}
        </div>
        {/* Children: aquifers, or for single-unit regions, rasters/models directly */}
        {isExpanded && hasChildren && (
          <div className={r.singleUnit ? 'space-y-0' : undefined}>
            {r.singleUnit
              ? <>
                  {regionRasters.map(m => renderRasterRow(m))}
                  {regionModels.map(m => renderModelRow(m))}
                </>
              : regionAquifers.map(a => renderAquiferRow(a, r.id))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="w-80 bg-white border-r border-slate-200 flex flex-col shadow-xl z-20">
      <div className="p-6 border-b border-slate-100 flex items-center space-x-3 bg-gradient-to-br from-blue-600 to-indigo-700">
        <Droplets className="text-white" size={28} />
        <div>
          <h1 className="text-lg font-bold text-white tracking-tight leading-none">Aquifer Analyst</h1>
          <p className="text-blue-100 text-[10px] font-medium uppercase mt-1">Groundwater Intelligence</p>
        </div>
      </div>

      <div
        ref={treeRef}
        className="flex-1 overflow-y-auto py-2"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        {regions.map(r => renderRegionRow(r))}
        {regions.length === 0 && (
          <p className="text-xs text-slate-400 italic px-3 py-2">No regions loaded.</p>
        )}
      </div>

      <div className="p-4 bg-slate-50 border-t border-slate-100">
        <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm text-center">
          <p className="text-[10px] text-slate-400 uppercase font-bold mb-1">Status</p>
          <div className="flex items-center justify-center space-x-2">
            <span className="flex h-2 w-2 rounded-full bg-green-500"></span>
            <span className="text-xs font-medium text-slate-600">Sync Active</span>
          </div>
        </div>
      </div>

      {/* Edit Region Modal */}
      {editing && editing.startsWith('region-') && (() => {
        const regionId = editing.replace('region-', '');
        return (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
            <div ref={editModalRef} className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-6">
              <h3 className="text-lg font-bold text-slate-800 mb-4">Edit Region</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
                  <input
                    ref={editInputRef}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') confirmEditRegion(regionId);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Length Unit</label>
                  <div className="flex space-x-2">
                    <button
                      type="button"
                      onClick={() => setEditUnit('ft')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        editUnit === 'ft'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Feet (ft)
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditUnit('m')}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        editUnit === 'm'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      Meters (m)
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex justify-end space-x-3 mt-6">
                <button
                  onClick={() => setEditing(null)}
                  className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => confirmEditRegion(regionId)}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </aside>
  );
};

export default Sidebar;
