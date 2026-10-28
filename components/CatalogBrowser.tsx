import React, { useState, useEffect, useMemo } from 'react';
import { X, Search, ChevronRight, ChevronDown, Loader2, Info } from 'lucide-react';
import { ParameterCatalog, CatalogParameter } from '../types';
import { loadCatalog, groupCatalog } from '../services/catalog';

interface CatalogBrowserProps {
  onClose: () => void;
}

const CatalogBrowser: React.FC<CatalogBrowserProps> = ({ onClose }) => {
  const [catalog, setCatalog] = useState<ParameterCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedCode, setSelectedCode] = useState<string | null>(null);

  useEffect(() => {
    loadCatalog().then(cat => {
      setCatalog(cat);
      // Expand all groups by default on first load
      setExpandedGroups(new Set(Object.keys(groupCatalog(cat))));
    }).catch(() => setCatalog({ parameters: {} }));
  }, []);

  const grouped = useMemo<Record<string, Array<{ code: string; param: CatalogParameter }>>>(
    () => (catalog ? groupCatalog(catalog) : {}),
    [catalog]
  );

  type GroupEntry = { code: string; param: CatalogParameter };
  type Grouped = Record<string, GroupEntry[]>;

  const normalizedQuery = query.toLowerCase().trim();
  const filteredGroups = useMemo<Grouped>(() => {
    if (!normalizedQuery) return grouped;
    const result: Grouped = {};
    for (const group of Object.keys(grouped)) {
      const entries = grouped[group];
      const matches = entries.filter(({ code, param }) =>
        code.toLowerCase().includes(normalizedQuery) ||
        param.name.toLowerCase().includes(normalizedQuery) ||
        (param.wqp?.characteristicName || '').toLowerCase().includes(normalizedQuery)
      );
      if (matches.length > 0) result[group] = matches;
    }
    return result;
  }, [grouped, normalizedQuery]);

  const totalShown = Object.keys(filteredGroups).reduce<number>((sum, g) => sum + filteredGroups[g].length, 0);
  const totalAll = Object.keys(grouped).reduce<number>((sum, g) => sum + grouped[g].length, 0);

  const toggleGroup = (g: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g); else next.add(g);
      return next;
    });
  };

  const selectedParam = useMemo(() => {
    if (!catalog || !selectedCode) return null;
    return catalog.parameters[selectedCode] || null;
  }, [catalog, selectedCode]);

  // When a query is active, auto-expand every matching group so results are visible
  const effectiveExpanded = normalizedQuery ? new Set(Object.keys(filteredGroups)) : expandedGroups;

  const groupNames = Object.keys(filteredGroups).sort();

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Parameter Catalog</h2>
            <p className="text-xs text-slate-500">
              {catalog ? `${totalShown}${normalizedQuery ? ` of ${totalAll}` : ''} parameters, ${Object.keys(grouped).length} groups` : 'Loading…'}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={20} /></button>
        </div>

        {/* Info banner */}
        <div className="px-6 pt-3">
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800">
            <Info size={14} className="mt-0.5 shrink-0" />
            <p>
              These are the standardized water quality parameters every region shares.
              They appear automatically in a region's data type dropdown once you import a
              column matching one of them — no need to pre-declare. MCL and WHO values,
              when available, are shown as regulatory references.
            </p>
          </div>
        </div>

        {/* Search */}
        <div className="px-6 pt-3">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name, code, or WQP characteristic..."
              className="w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </div>

        {/* Groups */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {!catalog ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-4">
              <Loader2 size={14} className="animate-spin" /> Loading catalog…
            </div>
          ) : groupNames.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 italic">No parameters match "{query}".</p>
          ) : (
            <div className="space-y-2">
              {groupNames.map(group => {
                const entries = filteredGroups[group];
                const expanded = effectiveExpanded.has(group);
                return (
                  <div key={group} className="border border-slate-200 rounded-lg">
                    <button
                      onClick={() => toggleGroup(group)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      <span className="flex items-center gap-1">
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {group}
                      </span>
                      <span className="text-xs text-slate-400">{entries.length}</span>
                    </button>
                    {expanded && (
                      <table className="w-full text-xs border-t border-slate-100">
                        <thead>
                          <tr className="text-left text-slate-400">
                            <th className="py-1.5 pl-3 pr-2 font-medium">Name</th>
                            <th className="py-1.5 pr-2 font-medium">Code</th>
                            <th className="py-1.5 pr-2 font-medium">Unit</th>
                            <th className="py-1.5 pr-2 font-medium">MCL</th>
                            <th className="py-1.5 pr-3 font-medium">WHO</th>
                          </tr>
                        </thead>
                        <tbody>
                          {entries.map(({ code, param }) => {
                            const isSelected = selectedCode === code;
                            return (
                              <React.Fragment key={code}>
                                <tr
                                  onClick={() => setSelectedCode(isSelected ? null : code)}
                                  className={`border-t border-slate-50 cursor-pointer ${isSelected ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                                >
                                  <td className="py-1.5 pl-3 pr-2 text-slate-700">{param.name}</td>
                                  <td className="py-1.5 pr-2 font-mono text-slate-500">{code}</td>
                                  <td className="py-1.5 pr-2 text-slate-600">{param.unit || '—'}</td>
                                  <td className="py-1.5 pr-2 text-slate-600">{param.mcl ?? '—'}</td>
                                  <td className="py-1.5 pr-3 text-slate-600">{param.who ?? '—'}</td>
                                </tr>
                                {isSelected && param.wqp && (
                                  <tr className="border-t border-slate-50 bg-blue-50">
                                    <td colSpan={5} className="py-2 pl-8 pr-3 text-[11px] text-slate-600">
                                      <div><span className="text-slate-400">WQP CharacteristicName:</span> <span className="font-mono">{param.wqp.characteristicName}</span></div>
                                      <div><span className="text-slate-400">WQP SampleFraction:</span> <span className="font-mono">{param.wqp.sampleFraction || '—'}</span></div>
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-100 flex justify-end">
          <button onClick={onClose} className="px-6 py-2 bg-slate-800 text-slate-50 rounded-lg font-medium text-sm hover:bg-slate-700">Close</button>
        </div>
      </div>
    </div>
  );
};

export default CatalogBrowser;
