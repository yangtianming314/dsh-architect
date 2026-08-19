/* dsh-architect Client half: settings.section. */
window.__ModuleLoader__.load({
  id: "@yangtianming314/dsh-architect",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;
    var inject = ["slots", "remote"];
    var identity = function (value) { return value; };
    var codec = function (symbol) { return { mode: "strict", typeSymbol: symbol, schema: { parse: identity } }; };
    var CONTRIBUTION = {
      package: "dsh-architect",
      descriptors: [
        {
          id: "dsh-architect#architect/settings",
          service: "architect",
          namespace: "architect",
          method: "settings",
          invocation: { kind: "direct" },
          parameters: [],
          result: codec("dsh-architect#ArchitectSettingsResult")
        },
        {
          id: "dsh-architect#architect/catalog",
          service: "architect",
          namespace: "architect",
          method: "catalog",
          invocation: { kind: "direct" },
          parameters: [{ name: "sessionId", wire: "sessionId", source: "json", codec: codec("dsh-architect#SessionId") }],
          result: codec("dsh-architect#ArchitectCatalogResult")
        },
        {
          id: "dsh-architect#architect/mutateSettings",
          service: "architect",
          namespace: "architect",
          method: "mutateSettings",
          invocation: { kind: "direct" },
          parameters: [
            { name: "ops", wire: "ops", source: "json", codec: codec("dsh-architect#SettingsOperations") },
            { name: "expectedRevision", wire: "expectedRevision", source: "json", codec: codec("dsh-architect#SettingsRevision") }
          ],
          result: codec("dsh-architect#ArchitectSettingsResult")
        }
      ]
    };

    var css = [
      ".arch-settings{display:flex;flex-direction:column;gap:14px;padding:6px 2px 26px;min-width:0;color:var(--dsw-alias-label-primary,#e8e8e8)}",
      ".arch-settings-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".arch-settings-title{font-size:15px;font-weight:650}",
      ".arch-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}",
      ".arch-settings-field{display:flex;flex-direction:column;gap:5px;min-width:0}",
      ".arch-settings-field label{font-size:12px;color:var(--dsw-alias-label-secondary,#a1a1a1)}",
      ".arch-settings-field input,.arch-settings-field select{width:100%;box-sizing:border-box;min-height:32px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#3a3a3a);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#242424);color:var(--dsw-alias-label-primary,#e8e8e8);font-size:12px;outline:none}",
      ".arch-settings-field input:focus,.arch-settings-field select:focus{border-color:var(--dsw-alias-brand-primary,#4f8cff)}",
      ".arch-settings-error{padding:9px 10px;border:1px solid var(--dsw-alias-state-error-primary,#e66);border-radius:6px;color:var(--dsw-alias-state-error-primary,#e66);font-size:12px;overflow-wrap:anywhere}",
      ".arch-settings-notice{font-size:12px;color:var(--dsw-alias-state-success-primary,#55c98a)}",
      ".arch-settings-empty{padding:24px 0;color:var(--dsw-alias-label-secondary,#999);font-size:12px}",
      "@media(max-width:560px){.arch-settings-grid{grid-template-columns:minmax(0,1fr)}}"
    ].join("");

    function installCss(ctx) {
      var tagId = "dsh-architect/client.css";
      var pluginId = "@yangtianming314/dsh-architect";
      var insert = function () {
        if (typeof document === "undefined") return;
        var selector = "style[data-plugin-css=" + JSON.stringify(tagId) + "]";
        var existing = document.querySelector(selector);
        if (existing) {
          existing.setAttribute("data-plugin", pluginId);
          return;
        }
        var tag = document.createElement("style");
        tag.setAttribute("data-plugin", pluginId);
        tag.setAttribute("data-plugin-css", tagId);
        tag.textContent = css;
        (document.head || document.documentElement).appendChild(tag);
      };
      var remove = function () {
        if (typeof document === "undefined") return;
        var tags = document.querySelectorAll("style[data-plugin-css=" + JSON.stringify(tagId) + "]");
        for (var i = 0; i < tags.length; i += 1) tags[i].remove();
      };
      insert();
      ctx.effect(function () { return remove; }, "dsh-architect: styles");
    }

    var remoteMount;
    var callRemote = function (method) {
      var rest = Array.prototype.slice.call(arguments, 1);
      return remoteMount.then(function () {
        var remote = ctxRemote;
        if (!remote || typeof remote[method] !== "function") throw new Error("architect remote unavailable");
        return remote[method].apply(remote, rest);
      }).then(function (result) {
        if (!result || !result.ok) {
          var code = result && result.error && result.error.code;
          var message = result && result.error && result.error.message;
          throw new Error("architect." + method + " failed" + (code ? " [" + code + "]" : "") + (message ? ": " + message : ""));
        }
        return result.value;
      });
    };
    var ctxRemote;

    function rpcSettings() {
      return callRemote("settings");
    }

    function rpcCatalog(sessionId) {
      return callRemote("catalog", sessionId || null);
    }

    function executionModelValue(config, key) {
      var model = config && config.settings && config.settings.executionModel;
      return model && model[key] !== undefined && model[key] !== null ? model[key] : "";
    }

    function modelFor(catalog, providerId, modelId) {
      var providers = catalog && Array.isArray(catalog.providers) ? catalog.providers : [];
      for (var i = 0; i < providers.length; i += 1) {
        if (providers[i].id !== providerId) continue;
        var models = Array.isArray(providers[i].models) ? providers[i].models : [];
        for (var j = 0; j < models.length; j += 1) if (models[j].id === modelId) return models[j];
      }
      return null;
    }

    function providerModels(catalog, providerId) {
      var providers = catalog && Array.isArray(catalog.providers) ? catalog.providers : [];
      for (var i = 0; i < providers.length; i += 1) if (providers[i].id === providerId) return providers[i].models || [];
      return [];
    }

    function ArchitectSettings(props) {
      var state = React.useState(null); var config = state[0]; var setConfig = state[1];
      var catState = React.useState({ providers: [], tools: [] }); var catalog = catState[0]; var setCatalog = catState[1];
      var loadState = React.useState(true); var loading = loadState[0]; var setLoading = loadState[1];
      var errorState = React.useState(null); var error = errorState[0]; var setError = errorState[1];
      var noticeState = React.useState(""); var notice = noticeState[0]; var setNotice = noticeState[1];

      var load = function () {
        setLoading(true);
        Promise.all([rpcSettings(), rpcCatalog()]).then(function (values) {
          setConfig(values[0]);
          setCatalog(values[1] || { providers: [], tools: [] });
          setError(null);
        }).catch(function (err) {
          setError(String((err && err.message) || err));
        }).finally(function () { setLoading(false); });
      };
      React.useEffect(function () { load(); }, []);

      var saveOps = function (ops) {
        if (!config || !config.writable) return;
        setNotice("");
        return callRemote("mutateSettings", ops, config.revision).then(function (result) {
          if (!result || result.ok === false) throw new Error(result && result.error ? result.error : "保存失败");
          setConfig(result);
          setError(null);
          setNotice("已保存");
          return result;
        }).catch(function (err) {
          setError(String((err && err.message) || err));
          throw err;
        });
      };

      var saveField = function (path, value) {
        saveOps([{ op: "set", path: path, value: value }]).catch(function () {});
      };

      var renderModel = function () {
        var providerId = executionModelValue(config, "provider");
        var modelId = executionModelValue(config, "model");
        var effort = executionModelValue(config, "reasoningEffort");
        var models = providerModels(catalog, providerId);
        var currentModel = modelFor(catalog, providerId, modelId);
        var efforts = currentModel && Array.isArray(currentModel.efforts) ? currentModel.efforts : [];
        var writable = !config || !config.writable ? false : true;
        var setModelValue = function (key, value) {
          var nextModel = Object.assign({}, config.settings.executionModel, { [key]: value });
          setConfig(Object.assign({}, config, { settings: Object.assign({}, config.settings, { executionModel: nextModel }) }));
        };
        return h("div", { className: "arch-settings-grid" },
          h("div", { className: "arch-settings-field" },
            h("label", null, "Provider"),
            h("select", { value: providerId, disabled: !writable, onChange: function (e) {
              var nextProvider = e.target.value;
              var nextModels = providerModels(catalog, nextProvider);
              var nextModel = nextModels.length ? nextModels[0].id : modelId;
              var nextEffort = nextModels.length && nextModels[0].efforts && nextModels[0].efforts.length ? nextModels[0].efforts[0].id : effort;
              saveOps([
                { op: "set", path: ["executionModel", "provider"], value: nextProvider },
                { op: "set", path: ["executionModel", "model"], value: nextModel },
                { op: "set", path: ["executionModel", "reasoningEffort"], value: nextEffort }
              ]).catch(function () {});
            } },
              (catalog.providers || []).map(function (provider) { return h("option", { key: provider.id, value: provider.id }, provider.name + " (" + provider.id + ")"); }),
              !catalog.providers.length ? h("option", { value: providerId }, providerId || "未发现 provider") : null
            )
          ),
          h("div", { className: "arch-settings-field" },
            h("label", null, "Model"),
            models.length
              ? h("select", { value: modelId, disabled: !writable, onChange: function (e) {
                  var next = modelFor(catalog, providerId, e.target.value);
                  var nextEffort = next && next.efforts && next.efforts.length ? next.efforts[0].id : effort;
                  saveOps([
                    { op: "set", path: ["executionModel", "model"], value: e.target.value },
                    { op: "set", path: ["executionModel", "reasoningEffort"], value: nextEffort }
                  ]).catch(function () {});
                } }, models.map(function (model) { return h("option", { key: model.id, value: model.id }, model.name + " (" + model.id + ")"); }))
              : h("input", { value: modelId, disabled: !writable, onChange: function (e) { setModelValue("model", e.target.value); }, onBlur: function (e) { saveField(["executionModel", "model"], e.target.value); } })
          ),
          h("div", { className: "arch-settings-field" },
            h("label", null, "推理程度"),
            efforts.length
              ? h("select", { value: effort, disabled: !writable, onChange: function (e) { saveField(["executionModel", "reasoningEffort"], e.target.value); } }, efforts.map(function (item) { return h("option", { key: item.id, value: item.id }, item.name + " (" + item.id + ")"); }))
              : h("input", { value: effort, disabled: !writable, onChange: function (e) { setModelValue("reasoningEffort", e.target.value); }, onBlur: function (e) { saveField(["executionModel", "reasoningEffort"], e.target.value); } })
          )
        );
      };

      if (loading && !config) return h("div", { className: "arch-settings" }, h("div", { className: "arch-settings-empty" }, "加载架构师设置…"));
      if (!config) return h("div", { className: "arch-settings" }, h("div", { className: "arch-settings-error" }, error || "设置不可用"));
      return h("div", { className: "arch-settings" },
        h("div", { className: "arch-settings-head" }, h("div", { className: "arch-settings-title" }, "AI 架构师")),
        h("div", { className: "arch-settings-grid" },
          h("div", { className: "arch-settings-field" }, h("label", null, "最大并行子代理"), h("input", { type: "number", min: 1, max: 32, value: config.settings.maxParallel, disabled: !config.writable, onChange: function (e) { var value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= 32) saveField(["maxParallel"], value); } }))
        ),
        renderModel(),
        notice ? h("div", { className: "arch-settings-notice" }, notice) : null,
        error ? h("div", { className: "arch-settings-error" }, error) : null
      );
    }

    function apply(ctx) {
      installCss(ctx);
      remoteMount = ctx.remote.$mount(CONTRIBUTION).then(function () {
        ctxRemote = ctx.get("remote.architect");
      });
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({ name: "settings.section", id: "architect", order: 18, label: "AI 架构师" }, ArchitectSettings);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ArchitectSettings = ArchitectSettings;
    return module.exports;
  }
});
