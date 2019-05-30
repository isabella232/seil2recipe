/*! seil2recipe.js v1.0.0
 * https://github.com/iij/seil2recipe
 *
 * Copyright (c) 2019 Internet Initiative Japan Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT.  IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
 * IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

class Converter {
    constructor(seilconfig) {
        this.seilconfig  = seilconfig;
        this.conversions = [];
        this.note        = new Note();

        this.convert();
    }

    get recipe_config() {
        const lines = Array.prototype.concat.apply([], this.conversions.map(rl => rl.recipe));
        return beautify(lines);
    }

    convert() {
        const lines = this.seilconfig.trim().split("\n")

        lines.forEach((line, idx) => {
            const conv = new Conversion(line, idx + 1, this.note);
            const tokens = tokenize(line)

            let node = Converter.rules;
            for (let i = 0; i < tokens.length; i++) {
                conv.label = tokens.slice(0, i + 1).join(' ');

                var val = node[tokens[i]];
                if (!val && node['*']) {
                    val = node['*'];
                }

                if (val instanceof Function) {
                    if (val.length == 1) {
                        val = val(tokens);
                    } else if (val.length == 2) {
                        val(conv, tokens);
                        break;
                    } else {
                        // XXX raise an error!
                    }
                }

                if (val instanceof Array) {
                    val.forEach(line => conv.recipe.push(line));
                    break;
                } else if (val == 'deprecated') {
                    conv.deprecated();
                    break;
                } else if (val == 'notsupported') {
                    conv.notsupported();
                    break;
                } else if (typeof val == 'string') {
                    if (val != '') {
                        conv.recipe.push(val)
                    }
                    break;
                } else if (val === undefined) {
                    conv.syntaxerror();
                    break;
                } else {
                    node = val;
                    continue;
                }
            }
            if (node instanceof Object && node['.']) {
                node['.'](conv, tokens);
            }

            this.conversions.push(conv);
        });

        this.conversions.forEach((conv) => {
            conv.defers.forEach((fun) => {
                fun(conv);
            });
        });
    }
}


class Note {
    constructor() {
        this.indices = new Map();  // (prefix) -> (last index number)
        this.params  = new Map();
        this.interfaces = new Map();  // (iftype) -> (last interface index)
        this.ifindex = new Map();  // (prefix) -> (interface) -> (index)
        this.memo    = new Map();

        this.memo.set('floatlink.interfaces', []);
        this.memo.set('ike.preshared-key', {});
        this.memo.set('interface.l2tp.tunnel', {});
    }

    get_memo(key) {
        return this.memo.get(key);
    }

    set_memo(key, value) {
        this.memo.set(key, value);
    }

    get_interface(iftype) {
        var idx = this.interfaces.get(iftype);
        if (idx) {
            idx += 1;
        } else {
            idx = 0;
        }
        this.interfaces.set(iftype, idx);
        return `${iftype}${idx}`;
    }

    get_saindex() {
        const prefix = 'ipsec.security-association.sa';
        var idx = this.indices.get(prefix);
        if (idx) {
            idx += 1;
        } else {
            idx = 0;
        }
        this.indices.set(prefix, idx);
        return `sa${idx}`;
    }

    get_params(prefix) {
        return this.params[prefix];
    }

    if2index(prefix, ifname) {
        var ifmap = this.ifindex.get(prefix);
        if (ifmap == null) {
            ifmap = new Map();
            ifmap['*'] = 100;
            this.ifindex.set(prefix, ifmap);
        }
        var idx = ifmap[ifname];
        if (idx == null) {
            idx = ifmap['*'];
            ifmap['*'] += 100;
            ifmap[ifname] = idx;
        }
        return idx;
    }

    set_param(prefix, label, key, value) {
        this.params[prefix][label][key] = value;
    }
}

class Conversion {
    constructor(seil_line, lineno, note) {
        this.seil_line = seil_line
        this.lineno    = lineno;
        this.note      = note;

        this.recipe = [];
        this.errors = [];
        this.prefix = '';
        this.defers = [];
    }

    // add a key/value pair of recipe config.
    add(key, value) {
        if (arguments.length == 1) {
            this.recipe.push(key);
        } else {
            if (value == '') {
                value = '""';
            } else if (value.match(/['"\\ ]/)) {
                value = '"' + value.replace(/(["\\])/g, "\\$1") +'"';
            }

            this.recipe.push(key + ": " + value);
        }
    }

    defer(fun) {
        this.defers.push(fun);
    }

    //
    // Conversion Utility
    //
    ifmap(new_name) {
        return ifmap(new_name);
    }

    time2sec(str) {
        const a = str.match(/^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s?)?$/);
        var sec = parseInt(a[3], 10);
        if (a[2]) {
            sec += parseInt(a[1]) * 60;  // minutes
        }
        if (a[1]) {
            sec += parseInt(a[2]) * 60 * 60;  // hours
        }
        return String(sec);
    }

    //
    // Proxy methods
    //
    get_index(prefix, zero_origin) {
        var idx = this.note.indices.get(prefix);
        if (!zero_origin) {
            // 前後にコンフィグを追加しやすいように 100, 200, 300, ... とする。
            if (idx == null) {
                idx = 100;
            } else {
                idx += 100;
            }
        } else {
            // syslog.remote.server は 0 はじまりしか受け入れない。
            if (idx == null) {
                idx = 0;
            } else {
                idx += 1;
            }
        }
        this.note.indices.set(prefix, idx);
        return `${prefix}.${idx}`;
    }

    get_interface(iftype) {
        return this.note.get_interface(iftype);
    }

    get_memo(key) {
        return this.note.get_memo(key);
    }

    get_saindex() {
        return this.note.get_saindex();
    }

    get_params(prefix) {
        return this.note.get_params(prefix);
    }

    if2index(prefix, ifname) {
        return this.note.if2index(prefix, ifname);
    }

    read_params(prefix, tokens, idx, defs) {
        const name = tokens[idx];
        const params = { '*NAME*': name };
        idx += 1;

        while (idx < tokens.length) {
            const pname = tokens[idx];
            var val = defs[pname];
            if (val == null) {
                this.badconfig(pname);
                idx += 1;
                continue;
            }
            if (val instanceof Object && val.key) {
                const pdef = val;
                var val = tokens[idx + 1];
                if (pdef.fun) {
                    val = pdef.fun(val);
                }
                params[pname] = val;
                this.add(pdef.key, val);
                idx += 2;
                continue;
            }
            if (val instanceof Function) {
                val = val.call(null, tokens[idx + 1]);
            }
            if (defs[pname] == 'notsupported') {
                this.notsupported(pname);
                idx += 2;
            } else if (Number.isInteger(defs[pname])) {
                const num = defs[pname];
                if (num == 0) {
                    params[pname] = true;
                } else {
                    params[pname] = tokens.slice(idx + 1, num);
                }
                idx += 1 + num;
            } else if (defs[pname] == true) {
                params[pname] = tokens[idx + 1];
                idx += 2;
            } else if (typeof val == 'string' && !(defs[pname] instanceof Function)) {
                params[pname] = tokens[idx + 1];
                this.add(val, params[pname]);
                idx += 2;
            } else {
                params[pname] = val;
                idx += 2;
            }
        }

        if (prefix) {
            if (this.note.params[prefix] == null) {
                this.note.params[prefix] = {};
            }
            this.note.params[prefix][name] = params;
        }
        return params;
    }

    set_memo(key, value) {
        return this.note.set_memo(key, value);
    }

    set_param(prefix, label, key, value) {
        this.note.set_param(prefix, label, key, value);
    }

    natifname(seilif) {
        if (seilif) {
            return this.ifmap(seilif);
        } else {
            return this.ifmap('lan1');
        }
    }

    param2recipe(params, param_name, recipe_key, fun) {
        if (params[param_name]) {
            var val = params[param_name];
            if (fun) {
                val = fun(val);
            }
            this.add(recipe_key, val);
        }
    }

    //
    // Error reporting
    //

    badconfig(message, label) {
        if (label == null) {
            label = this.label;
        }
        this.errors.push(new Error('badconfig', message));
    }

    deprecated(label) {
        if (label === undefined) {
            label = this.label;
        }
        this.errors.push(new Error('deprecated', `"${label}" は廃止されました。`));
    }

    notsupported(label) {
        if (label == null) {
            label = this.label;
        }
        this.errors.push(new Error('notsupported', `"${label}" は SEIL/X4 ではサポートされていません。`));
    }

    syntaxerror(label) {
        if (label == null) {
            label = this.label;
        }
        this.errors.push(new Error('syntaxerror', `"${label}" は解釈できません。`));
    }
}

class Error {
    constructor(type, message) {
        this.type    = type;
        this.message = message;
    }
}

function tokenize(line) {
    const tokens = []
    let token = ""
    line = line.trim();
    while (line != "") {
        if (line[0] == '"') {
            const a = line.match(/"((?:\\\\|\\"|[^"])*?)"\s*/)
            token = a[1].replace(/\\(.)/g, "$1")
            line = line.slice(a[0].length)
        } else {
            const a = line.match(/(\S+)\s*/)
            token = a[1]
            line = line.slice(a[0].length)
        }
        tokens.push(token)
    }
    return tokens
}

function unquote(qstr) {
    if (qstr && qstr.match(/^".*"$/)) {
        return qstr.slice(1, qstr.length - 1).replace(/\\(.)/g, '$1');
    } else {
        return qstr;
    }
}

function beautify(recipe_lines) {
    const sorted = recipe_lines.sort((a, b) => {
        let i = 0;
        let j = 0;
        for (;;) {
            if (!a[i]) {
                if (!b[j]) {
                    return 0;
                } else {
                    return 1;
                }
            } else if (!b[j]) {
                retrun -1;
            }

            const ma = a.substring(i).match(/^\d+/g);
            const mb = b.substring(j).match(/^\d+/g);
            if (ma && mb) {
                const na = Number(ma[0]);
                const nb = Number(mb[0]);
                if (na != nb) {
                    return na - nb;
                }
                i += ma[0].length;
                j += mb[0].length;
                continue;
            } else {
                if (a[i] != b[j]) {
                    return a[i].localeCompare(b[j]);
                }
                i++;
                j++;
            }
        }
    });
    return sorted.join('\n') + '\n';
}

function ifmap(seilif) {
    const bpv4_x4 = {
        'lan0': 'ge1',
        'lan1': 'ge0',
        'lan2': 'ge2',
    }
    return bpv4_x4[seilif] || seilif;
}

function on2enable(onoff) {
    if (onoff == 'on') {
        return 'enable';
    } else if (onoff == 'off') {
        return 'disable';
    }
}

String.prototype.is_ipv4_address = function() {
    return this.includes('.');
}

//
// Conversion Rules
//

Converter.rules = {};

Converter.rules['application-gateway'] = {
    '*': 'notsupported',
    'todo': {
        'bridging-interface': {
            'add': (conv, tokens) => {
                const k = conv.get_index('application-gateway.input.ipv4.bridging');
                conv.add(`${k}.interface: ${ifmap(tokens[3])}`);
            },
        },
        // https://www.seil.jp/doc/index.html#fn/appgw/cmd/application-gateway_input-interface.html
        'input-interface': {
            'add': tokens => {
                const k = newindex('application-gateway.input.ipv4.gateway');
                return `${k}.interface: ${ifmap(tokens[3])}`;
            },
        },

        'service': {
            'add': {
                '*': {
                    'mode': {
                        'http': tokens => {
                            const lines = [];
                            const k = newindex('application-gateway.service');
                            let i = 5;

                            lines.push('${k}.mode: http');
                            i += 1;

                            if (tokens[i] == 'destination-port') {
                                lines.push(`${k}.destination.port: ${tokens[i + 1]}`);
                                i += 2;
                            }
                            if (tokens[i] == 'destination') {
                                if (tokens[i + 1] != 'any') {
                                    lines.push(`${k}.destination.address: ${tokens[i + 1]}`);
                                }
                                i += 2;
                            }
                        }
                    }
                }
            }
        }
    }
};

Converter.rules['arp'] = {
    // https://www.seil.jp/doc/index.html#fn/arp/cmd/arp.html#add
    'add': (conv, tokens) => {
        const k = conv.get_index('arp');
        conv.add(`${k}.ipv4-address`, tokens[2]);
        conv.add(`${k}.mac-address`, tokens[3]);
        if (tokens[4] == 'proxy') {
            conv.add(`${k}.proxy`, on2enable(tokens[5]));
        }
    },
    'reply-nat': {
        'on': 'notsupported',
        'off': [],
    }
};

Converter.rules['authentication'] = {
    'account-list': {
        '*': {
            'url': {
                '*': {
                    'interval': (conv, tokens) => {
                        // https://www.seil.jp/doc/index.html#fn/pppac/cmd/authentication_account-list.html
                        // https://www.seil.jp/sx4/doc/sa/pppac/config/interface.pppac.html
                        conv.set_memo(`authentication.realm.${tokens[2]}.url`, tokens[4]);
                        conv.set_memo(`authentication.realm.${tokens[2]}.interval`, tokens[6]);
                    }
                }
            }
        }
    },
    'local': {
        '*': {
            'user': {
                // https://www.seil.jp/doc/index.html#fn/pppac/cmd/authentication_local.html#user_add
                'add': (conv, tokens) => {
                    conv.read_params(`authentication.realm.${tokens[2]}.user`, tokens, 5, {
                        'password': true,
                        'framed-ip-address': true,
                        'framed-ip-netmask': true
                    });
                }
            }
        }
    },
    'radius': 'notsupported',
    'realm': {
        'add': {
            '*': {
                'type': (conv, tokens) => {
                    conv.read_params('authentication.realm', tokens, 3, {
                        'type': true,
                        'username-suffix': true
                    });
                }
            }
        }
    }
};

Converter.rules['bridge'] = {
    // https://www.seil.jp/doc/index.html#fn/bridge/cmd/bridge.html#enable
    'disable': [],
    'enable': (conv, tokens) => {
        conv.set_memo('bridge.enable', true);
        conv.add('interface.bridge0.member.100.interface', conv.ifmap('lan0'));
        conv.add('interface.bridge0.member.200.interface', conv.ifmap('lan1'));
    },
    'ip-bridging': (conv, tokens) => {
        if (conv.get_memo('bridge.enable')) {
            conv.add('interface.bridge0.forward.ipv4', on2enable(tokens[2]));
        }
    },
    'ipv6-bridging': (conv, tokens) => {
        if (conv.get_memo('bridge.enable')) {
            conv.add('interface.bridge0.forward.ipv6', on2enable(tokens[2]));
        }
    },
    'pppoe-bridging': (conv, tokens) => {
        if (conv.get_memo('bridge.enable')) {
            conv.add('interface.bridge0.forward.pppoe', on2enable(tokens[2]));
        }
    },
    'default-bridging': (conv, tokens) => {
        if (conv.get_memo('bridge.enable')) {
            conv.add('interface.bridge0.forward.other', on2enable(tokens[2]));
        }
    },

    'filter': 'notsupported',
    'vman-tpid': 'notsupported',

    // https://www.seil.jp/doc/index.html#fn/bridge/cmd/bridge_group.html#add
    'group': {
        'add': (conv, tokens) => {
            const bridge_if = conv.get_interface('bridge');
            conv.read_params('bridge.group', tokens, 3, {
                'stp': true,
            });
            conv.set_param('bridge.group', tokens[3], '*ifname*', bridge_if);
        }
    },

    // https://www.seil.jp/doc/index.html#fn/bridge/cmd/bridge_interface.html
    // https://www.seil.jp/sx4/doc/sa/bridge/config/interface.bridge.html
    'interface': {
        '*': {
            'group': (conv, tokens) => {
                const member_if = tokens[2];
                const group_name = tokens[4];
                const bg = conv.get_params('bridge.group');
                if (bg == undefined) {
                    conv.badconfig(`bridge group が定義されていません。`);
                    return;
                }
                const params = bg[group_name];
                if (params == null) {
                    conv.badconfig(`bridge group "${group_name}" が定義されていません。`);
                    return;
                }
                const bridge_if = params['*ifname*'];
                const k = conv.get_index(`interface.${bridge_if}.member`);

                conv.add(`${k}.interface`, ifmap(member_if));
            }
        }
    }
};

Converter.rules['cbq'] = {
    'class': 'notsupported',
    'filter': 'notsupported',

    // Without CBQ class/filter, link-bandwith can be ignored.
    'link-bandwidth': [],
};

Converter.rules['certificate'] = {
    'my': 'notsupported'
};

function dhcp_get_interface(conv, iftoken) {
    const mode = conv.get_memo('dhcp.mode');
    const ifname = conv.ifmap(iftoken);
    const idx1 = conv.if2index('dhcp.interface', ifname);
    if (conv.get_memo(`dhcp.interface.${idx1}`)) {
        return `dhcp.${mode}.${idx1}`;
    } else {
        return null;
    }
};

Converter.rules['dhcp'] = {
    'disable': (conv, tokens) => {
        conv.set_memo('dhcp', 'disable');
    },

    'enable': (conv, tokens) => {
        conv.set_memo('dhcp', 'enable');
    },

    'interface': {
        '*': {
            'disable': (conv, tokens) => {
                if (conv.get_memo('dhcp.mode') == 'relay') {
                    return;
                }
            },

            // dhcp interface <i/f> dns add <IPv4address>
            'dns': (conv, tokens) => {
                const k1 = dhcp_get_interface(conv, tokens[2]);
                if (k1 == null) {
                    return;
                }
                const k2 = conv.get_index(`${k1}.dns`);
                conv.add(`${k2}.address`, tokens[5]);
            },

            'domain': (conv, tokens) => {
                const k = dhcp_get_interface(conv, tokens[2]);
                if (k) {
                    conv.add(`${k}.domain`, tokens[4]);
                }
            },

            'enable': (conv, tokens) => {
                const mode = conv.get_memo('dhcp.mode');
                const ifname = conv.ifmap(tokens[2]);
                const idx = conv.if2index('dhcp.interface', ifname);
                conv.set_memo(`dhcp.interface.${idx}`, true);
                conv.add(`dhcp.${mode}.${idx}.interface`, ifname);
            },

            'expire': (conv, tokens) => {
                const k = dhcp_get_interface(conv, tokens[2]);
                if (k) {
                    conv.add(`${k}.expire`, tokens[4]);
                }
            },

            'gateway': (conv, tokens) => {
                const k = dhcp_get_interface(conv, tokens[2]);
                if (k) {
                    conv.add(`${k}.gateway`, tokens[4]);
                }
            },

            'ignore-unknown-request': (conv, tokens) => {
                const k = dhcp_get_interface(conv, tokens[2]);
                if (k) {
                    conv.add(`${k}.ignore-unknown-request`, on2enable(tokens[4]));
                }
            },

            // dhcp interface <i/f> ntp add <IPv4address>
            'ntp': (conv, tokens) => {
                const k1 = dhcp_get_interface(conv, tokens[2]);
                if (k1 == null) {
                    return;
                }
                const k2 = conv.get_index(`${k1}.ntp`);
                conv.add(`${k2}.address`, tokens[5]);
            },

            // dhcp interface <i/f> pool <IPv4address>[/<prefixlen>] <count>
            'pool': (conv, tokens) => {
                const ifname = tokens[2];
                const k1 = dhcp_get_interface(conv, ifname);
                if (k1 == null) {
                    return;
                }

                // address のプレフィクス長はわからない場合があるが、count は常にわかるため、
                // 先に書き出しておく。
                conv.add(`${k1}.pool.count`, tokens[5]);

                var addr = tokens[4];
                if (!addr.includes('/')) {
                    const plen = conv.get_memo(`interface.${ifname}.prefixlen`);
                    if (plen == null) {
                        conv.badconfig('pool のプレフィクス長が不明です。');
                        return;
                    }
                    addr = `${addr}/${plen}`;
                }
                conv.add(`${k1}.pool.address`, addr);
            },

            'server': {
                'add': (conv, tokens) => {
                    const ifname = conv.ifmap(tokens[2]);
                    const idx1 = conv.if2index('dhcp.interface', ifname);
                    if (conv.get_memo(`dhcp.interface.${idx1}`) == null) {
                        // recipe では disable されているインタフェースはコンフィグに書いてはいけない。
                        return;
                    }
                    const k = conv.get_index(`dhcp.relay.${idx1}.server`);
                    conv.add(`${k}.address`, tokens[5]);
                },
            },

            // dhcp interface <i/f> static add <MACaddress> <IPv4address>
            'static': {
                'add': (conv, tokens) => {
                    const k1 = dhcp_get_interface(conv, tokens[2]);
                    if (k1) {
                        const k2 = conv.get_index(`${k1}.static.entry`);
                        conv.add(`${k2}.mac-address`, tokens[5]);
                        conv.add(`${k2}.ip-address`, tokens[6]);
                    }
                },
                'external': {
                    'interval': (conv, tokens) => {
                        const k = dhcp_get_interface(conv, tokens[2]);
                        if (k) {
                            conv.add(`${k}.static.external.interval`, tokens[6]);
                        }

                    },
                    // dhcp interface <i/f> static external url <URL>
                    'url': (conv, tokens) => {
                        const k = dhcp_get_interface(conv, tokens[2]);
                        if (k) {
                            conv.add(`${k}.static.external.url`, tokens[6]);
                        }
                    },
                },
            },

            'wins-node': (conv, tokens) => {
                const k = dhcp_get_interface(conv, tokens[2]);
                if (k) {
                    conv.add(`${k}.wins-node.type`, tokens[4]);
                }
            },

            // dhcp interface <i/f> wins-server add <IPv4address>
            'wins-server': (conv, tokens) => {
                const k1 = dhcp_get_interface(conv, tokens[2]);
                if (k1) {
                    const k2 = conv.get_index(`${k1}.wins-server`);
                    conv.add(`${k2}.address`, tokens[5]);
                }
            },

            'wpad': (conv, tokens) => {
                const k = dhcp_get_interface(conv, tokens[2]);
                if (k) {
                    conv.add(`${k}.wpad.url`, tokens[4]);
                }
            },
        },
    },

    'mode': {
        'relay': (conv, tokens) => {
            conv.set_memo('dhcp.mode', 'relay');
            conv.add('dhcp.relay.service', conv.get_memo('dhcp'));
        },
        'server': (conv, tokens) => {
            conv.set_memo('dhcp.mode', 'server');
            conv.add('dhcp.server.service', conv.get_memo('dhcp'));
        },
    },

};

function dhcp6_client_get_interface(conv, iftoken) {
    const mode = conv.get_memo('dhcp6.client');
    const ifname = conv.ifmap(iftoken);
    const idx1 = conv.if2index('dhcp6.client.interface', ifname);
    if (conv.get_memo(`dhcp6.client.interface.${idx1}`)) {
        return `dhcp6.client.${idx1}`;
    } else {
        return null;
    }
};

function dhcp6_server_get_interface(conv, iftoken) {
    const ifname = conv.ifmap(iftoken);
    const idx1 = conv.if2index('dhcp6.server', ifname);
    if (conv.get_memo(`dhcp6.server.${idx1}`)) {
        return `dhcp6.server.${idx1}`;
    } else {
        return null;
    }
};

// https://www.seil.jp/doc/index.html#fn/dhcp/cmd/dhcp6_client.html
Converter.rules['dhcp6'] = {
    'client': {
        'disable': 'dhcp6.client.service: disable',
        'enable': 'dhcp6.client.service: enable',

        // dhcp6 client interface { <lan> | <ipsec> | <ppp> | <pppoe> | <tunnel> | <vlan> }
        'interface': {
            '*': {
                '.': (conv, tokens) => {
                    if (! conv.get_memo('dhcp6.client.multiple')) {
                        const ifname = conv.ifmap(tokens[3])
                        conv.set_memo('dhcp6.client.interface', ifname);
                        conv.add('dhcp6.client.100.interface', tokens[3]);
                    }
                },

                'disable': false,

                'enable': (conv, tokens) => {
                    const k1 = dhcp6_client_get_interface(tokens[3]);
                    conv.set_memo(k1, true);
                },

                'prefix-delegation': {
                    'add': (conv, tokens) => {
                        const k1 = dhcp6_client_get_interface(tokens[3]);
                        const subnet = conv.ifmap(tokens[6]);
                        const sla_id = conv.ifmap(tokens[8]);
                        const k2 = conv.if2index(`${k1}.prefix-delegation`, subnet);
                        conv.add(`${k2}.subnet`, subnet);
                        conv.add(`${k2}.sla-id`, sla_id);

                        if (tokens[9] == 'interface-id') {
                            conv.add(`${k2}.interface-id`, tokens[10]);
                        }
                    },
                    'force-option': (conv, tokens) => {
                        const k1 = dhcp6_client_get_interface(tokens[3]);
                        conv.add(`${k1}.prefix-delegation.force`, on2enable(tokens[6]));
                    },
                },
                'rapid-commit': 'notsupported',
                'reconf-accept': 'notsupported',
            },
        },

        // https://www.seil.jp/doc/index.html#fn/dhcp/cmd/dhcp6_client_multi.html#multiple
        // multiple の enable/disable で変換方法が大きく切り換わる。
        'multiple': (conv, tokens) => {
            conv.set_memo('dhcp6.client.multiple', (tokens[3] == 'enable'));
        },

        // dhcp6 client prefix-delegation subnet <i/f> sla-id <sla-id>
        //     [ interface-id { <interface-id> | system-default } ] [ enable | disable ]
        'prefix-delegation': {
            'add': (conv, tokens) => {
                const subnet = conv.ifmap(tokens[4]);
                const sla_id = conv.ifmap(tokens[6]);
                conv.add('dhcp6.client.100.prefix-delegation.100.subnet', subnet);
                conv.add('dhcp6.client.100.prefix-delegation.100.sla-id', sla_id);
                if (tokens[7] == 'interface-id') {
                    conv.add(`dhcp6.client.100.prefix-delegation.100.interface-id`, tokens[8]);
                }
            },

            // dhcp6 client interface <i/f> prefix-delegation force-option <on>
            'force-option': (conv, tokens) => {
                conv.add(`dhcp6.client.100.prefix-delegation.force`, on2enable(tokens[6]));
            },
        },

        // https://www.seil.jp/doc/index.html#fn/dhcp/cmd/dhcp6_client_multi.html#multiple
        // dhcp6 client primary-interface <i/f>
        'primary-interface': (conv, tokens) => {
            const ifname = conv.ifmap(tokens[3])
            conv.if2index('dhcp6.interface', ifname);  // reserve ifindex
        },

        // dhcp6 client rapid-commit { on | off }
        'rapid-commit': tokens => `dhcp6.client.rapid-commit: ${on2enable(tokens[3])}`,

        'reconf-accept': tokens => `dhcp6.client.reconf-accept: ${on2enable(tokens[3])}`,
    },

    'relay': 'notsupported',

    'server': {
        'interface': {
            '*': {
                'disable': [],

                'enable': (conv, tokens) => {
                    const ifname = conv.ifmap(tokens[3]);
                    const idx1 = conv.if2index('dhcp6.server', ifname);
                    conv.set_memo(`dhcp6.server.${idx1}`, true);
                },

                // dhcp6 server interface <i/f> dns add { dhcp6 | <IPv6address> } [ from <interface> ]
                'dns': (conv, tokens) => {
                    const k1 = dhcp6_server_get_interface(conv, tokens[3]);
                    if (k1 == null) {
                        return;
                    }
                    const k2 = conv.get_index(`${k1}.dns`);
                    conv.add(`${k2}.address`, tokens[6]);
                    if (tokens[7] == 'from') {
                        conv.add(`${k2}.client-interface`, tokens[8]);
                    }
                },

                // dhcp6 server interface <i/f> domain add <name>
                'domain': (conv, tokens) => {
                    const k1 = dhcp6_server_get_interface(conv, tokens[3]);
                    if (k1 == null) {
                        return;
                    }
                    const k2 = conv.get_index(`${k1}.domain`);
                    conv.add(`${k2}.domain`, tokens[6]);
                    // XXX X4 accepts only 1 domain name.
                },

                // dhcp6 server interface <i/f> preference <preference>
                'preference': (conv, tokens) => {
                    const k1 = dhcp6_server_get_interface(conv, tokens[3]);
                    if (k1 == null) {
                        return;
                    }
                    conv.add(`${k1}.preference`, tokens[5]);
                },

                // dhcp6 server interface <i/f> sntp add { dhcp6 | <IPv6address> } [ from <interface> ]
                'sntp': (conv, tokens) => {
                    const k1 = dhcp6_server_get_interface(conv, tokens[3]);
                    if (k1 == null) {
                        return;
                    }
                    const k2 = conv.get_index(`${k1}.sntp`);
                    conv.add(`${k2}.address`, tokens[6]);
                    if (tokens[7] == 'from') {
                        conv.add(`${k2}.client-interface`, tokens[8]);
                    }
                },

            },
        },
    },
};

Converter.rules['dialup-device'] = (conv, tokens) => {
    conv.notsupported()
};

Converter.rules['dialup-network'] = (conv, tokens) => {
    conv.notsupported()
};

Converter.rules['dns'] = {
    // https://www.seil.jp/doc/index.html#fn/dns_forwarder/cmd/dns_forwarder.html
    // https://www.seil.jp/sx4/doc/sa/dns-forwarder/config/dns-forwarder.html
    'forwarder': {
        'aaaa-filter': 'notsupported',

        // X4 は ppp, pppoe, wwan インタフェースで listen する機能を持たない。
        'accept-from-wan': 'deprecated',

        // dns forwarder add { dhcp | dhcp6 | ipcp | ipcp-auto | <IPaddress> }
        'add': (conv, tokens) => {
            const k1 = conv.get_index('dns-forwarder');
            conv.add(`${k1}.address`, tokens[3]);
        },

        'disable': 'dns-forwarder.service: disable',

        'enable': [
            // XXX
            // 旧 SEIL ではデフォルトですべてのインタフェースを listen していた。
            // X4 では明示的に指定しないと listen しない。
            'dns-forwarder.service: enable',
            'dns-forwarder.listen.100.interface: ge*',
            'dns-forwarder.listen.200.interface: ipsec*',
            'dns-forwarder.listen.300.interface: tunnel*',
            'dns-forwarder.listen.400.interface: bridge*',
            'dns-forwarder.listen.500.interface: vlan*',
            'dns-forwarder.listen.600.interface: pppac*',
        ],

        'query-translation': 'notsupported',
    }
};

Converter.rules['encrypted-password'] = 'deprecated';

Converter.rules['encrypted-password-long'] = {
    'admin': (conv, tokens) => {
        conv.add('login.admin.encrypted-password', tokens[2]);
    },
};

Converter.rules['environment'] = {
    'login-timer': tokens => `terminal.login-timer: ${tokens[2]}`,
    'pager': tokens => `terminal.pager: ${on2enable(tokens[2])}`,
    'terminal': 'deprecated',
};

Converter.rules['filter'] = {
    'add': (conv, tokens) => {
        // https://www.seil.jp/doc/index.html#fn/filter/cmd/filter.html#add
        // https://www.seil.jp/sx4/doc/sa/filter/config/filter.ipv4.html

        function param2recipe(params, param_name, recipe_key, fun) {
            if (params[param_name]) {
                conv.add(recipe_key, fun(params[param_name]));
            }
        }

        params = conv.read_params('filter.ipv4', tokens, 2, {
            'interface': value => ifmap(value),
            'direction': true,
            'action': true,
            'protocol': true,
            'icmp-type': true,
            'application': value => {
                conv.deprecated('application');
            },
            'src': true,
            'srcport': true,
            'dst': true,
            'dstport': true,
            'ipopts': true,
            'state': true,
            'keepalive': true,
            'logging': true,
            'label': true,
            'enable': false,  // ignored
            'disable': false,
        });
        if (params['disable']) {
            return;
        }

        const k = conv.get_index('filter.ipv4');
        param2recipe(params, 'interface', `${k}.interface`, val => val);
        param2recipe(params, 'direction', `${k}.direction`, val => {
            if (val == 'in/out') {
                return 'inout';
            } else {
                return val;
            }
        });
        param2recipe(params, 'action', `${k}.action`, val => val);
        param2recipe(params, 'protocol', `${k}.protocol`, val => val);
        param2recipe(params, 'icmp-type', `${k}.icmp-type`, val => val);
        param2recipe(params, 'src', `${k}.source.address`, val => val);
        param2recipe(params, 'srcport', `${k}.source.port`, val => val);
        param2recipe(params, 'dst', `${k}.destination.address`, val => val);
        param2recipe(params, 'dstport', `${k}.destination.port`, val => val);
        param2recipe(params, 'ipopts', `${k}.ipopts`, val => val);
        param2recipe(params, 'state', `${k}.state`, val => val);
        param2recipe(params, 'keepalive', `${k}.keepalive`, val => val);
        param2recipe(params, 'logging', `${k}.logging`, val => val);
        param2recipe(params, 'label', `${k}.label`, val => val);
    }
};

Converter.rules['filter6'] = {
    'add': (conv, tokens) => {
        // https://www.seil.jp/doc/index.html#fn/filter/cmd/filter6.html#add
        // https://www.seil.jp/sx4/doc/sa/filter/config/filter.ipv6.html

        function param2recipe(params, param_name, recipe_key, fun) {
            if (params[param_name]) {
                conv.add(recipe_key, fun(params[param_name]));
            }
        }

        params = conv.read_params('filter.ipv6', tokens, 2, {
            'interface': value => ifmap(value),
            'direction': true,
            'action': true,
            'protocol': true,
            'icmp-type': true,
            'src': true,
            'srcport': true,
            'dst': true,
            'dstport': true,
            'exthdr': true,
            'state': true,
            'logging': true,
            'label': true,
            'enable': false,  // ignored
            'disable': false,
        });
        if (params['disable']) {
            return;
        }

        const k = conv.get_index('filter.ipv6');
        param2recipe(params, 'interface', `${k}.interface`, val => val);
        param2recipe(params, 'direction', `${k}.direction`, val => val);
        param2recipe(params, 'action', `${k}.action`, val => val);
        param2recipe(params, 'protocol', `${k}.protocol`, val => val);
        param2recipe(params, 'icmp-type', `${k}.icmp-type`, val => val);
        param2recipe(params, 'src', `${k}.source.address`, val => val);
        param2recipe(params, 'srcport', `${k}.source.port`, val => val);
        param2recipe(params, 'dst', `${k}.destination.address`, val => val);
        param2recipe(params, 'dstport', `${k}.destination.port`, val => val);
        param2recipe(params, 'exthdr', `${k}.exthdr`, val => val);
        param2recipe(params, 'state', `${k}.state`, val => val);
        param2recipe(params, 'logging', `${k}.logging`, val => val);
        param2recipe(params, 'label', `${k}.label`, val => val);
    }
};

// https://www.seil.jp/doc/#fn/floatlink/cmd/floatlink.html
Converter.rules['floatlink'] = {
    'ike': {
        'proposal': {
            // floatlink ike proposal hash {system-default | { sha1 | sha256 | sha512 },...}
            'hash': (conv, tokens) => {
                tokens[4].split(",").forEach(hash => {
                    const k1 = conv.get_index('floatlink.ike.proposal.phase1.hash');
                    conv.add(`${k1}.algorithm`, hash);
                });
            },
        },
    },
    'ipsec': {
        'proposal': {
            'authentication-algorithm': (conv, tokens) => {
                tokens[4].split(",").forEach(hash => {
                    const k1 = conv.get_index('floatlink.ike.proposal.phase2.authentication');
                    conv.add(`${k1}.algorithm`, hash);
                });
            },
        },
    },

    'name-service': {
        // floatlink name-service add <url>
        // -> interface.ipsec[0-63].floatlink.name-service: <url>
        'add': (conv, tokens) => {
            // floatlink name-service は add で書くが、最大で一つしか設定できないため、
            // 上書きされる心配はしなくて良い。
            conv.get_memo('floatlink.interfaces').forEach(ifname => {
                conv.add(`interface.${ifname}.floatlink.name-service`, tokens[3]);
            });
        }
    },
    'route': 'notsupported',
};

Converter.rules['hostname'] = (conv, tokens) => {
    conv.add('hostname', tokens[1]);
};

Converter.rules['httpd'] = {
    'access': 'notsupported',

    'disable': [],

    // httpd { enable | disable }
    'enable': 'notsupported',

    'module': 'notsupported',
};

function ike_timers(conv, tokens) {
    // ike interval 40s [phase1-timeout 41m] [phase2-timeout 42m]
    conv.read_params(null, tokens, 0, {
        'retry': 'ike.retry',
        'interval': {
            key: 'ike.interval',
            fun: conv.time2sec,
        },
        'per-send': 'ike.per-send',
        'phase1-timeout': 'ike.phase1-timeout',
        'phase2-timeout': 'ike.phase2-timeout',
        'nat-keepalive-interval': 'ike.nat-keepalive-interval',
        'dpd-interval': 'ike.dpd-interval',
        'dpd-maxfail': 'dpd-maxfail',
    });
}

Converter.rules['ike'] = {
    // ike auto-initiation { enable | disable | system-default }
    // https://www.seil.jp/sx4/doc/sa/ipsec/config/ipsec.sa.html
    'auto-initiation': tokens => `ike.auto-initiation: ${tokens[2]}`,

    'dpd-interval': ike_timers,

    'dpd-maxfail': ike_timers,

    'exclusive-tail': tokens => `ike.exclusive-tail: ${tokens[2]}`,

    'interval': ike_timers,

    'maximum-padding-length': tokens => `ike.maximum-padding-length: ${tokens[2]}`,

    'nat-keepalive-interval': ike_timers,

    // https://www.seil.jp/doc/index.html#fn/ipsec/cmd/ike_peer.html#add
    'peer': {
        'add': (conv, tokens) => {
            const params = conv.read_params('ike.peer', tokens, 3, {
                'exchange-mode': true,
                'proposals': true,
                'address': true,
                'port': true,
                'check-level': true,
                'initial-contact': true,
                'my-identifier': true,    // XXX
                'peers-identifier': true, // XXX
                'nonce-size': true,
                'variable-size-key-exchange-payload': true,
                'tunnel-interface': true,
                'dpd': true,
                'esp-fragment-size': true,
                'nat-traversal': true,
                'send-transport-phase2-id ': true,
                'responder-only': true,
                'prefer-new-phase1': true,
            });
            conv.set_memo(`ike.peer.address.${params['address']}`, params);
        }
    },

    'per-send': ike_timers,
    'phase1-timeout': ike_timers,
    'phase2-timeout': ike_timers,

    'preshared-key': {
        // ike preshared-key add <peers-identifier> <key>
        'add': (conv, tokens) => {
            const label = unquote(tokens[3]);
            conv.get_memo('ike.preshared-key')[label] = tokens[4];
        }
    },
    'proposal': {
        'add': (conv, tokens) => {
            // ike proposal add <name> authentication { preshared-key } encryption ... hash ...
            //     dh-group ... [lifetime-of-time ...]
            conv.read_params('ike.proposal', tokens, 3, {
                'authentication': true,
                'encryption': true,
                'hash': true,
                'dh-group': true,
                'lifetime-of-time': true
            });
        }
    },

    'randomize-padding-length': tokens => `ike.randomize-padding-length: ${tokens[2]}`,

    'randomize-padding-value': tokens => `ike.randomize-padding-value: ${tokens[2]}`,

    'retry': tokens => `ike.retry: ${tokens[2]}`,

    'strict-padding-byte-check': tokens => `ike.strict-pdding-byte-check: ${tokens[2]}`,

};

Converter.rules['interface'] = {
    // https://www.seil.jp/doc/index.html#fn/interface/cmd/interface_lan.html
    // https://www.seil.jp/sx4/doc/sa/ge/config/interface.ge.html
    '*': {
        'add': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);

            // interface <lan> add router-advertisement
            // interface <lan> add dhcp6
            var af, remote, val;
            switch (tokens[3]) {
                // interface <lan> add dhcp [classless-static-route <on/off>]
                case 'dhcp':
                    af = 'ipv4';
                    val = 'dhcp';
                    if (tokens[4] == 'classless-static-route') {
                        conv.notsupported('classless-static-route');
                    }
                    break;
                case 'dhcp6':
                    af = 'ipv6';
                    val = 'dhcp6';
                    break;
                case 'router-advertisement':
                    af = 'ipv6';
                    val = 'router-advertisement';
                    break;
                default:
                    // interface <lan> add <IPaddress>[/<prefixlen>]
                    // interface <ipsec> add <IPaddress>[/<prefixlen>] remote <IPaddress>
                    if (tokens[3].is_ipv4_address()) {
                        af = 'ipv4';
                        if (tokens[3].includes('/') &&
                            conv.get_memo(`interface.${tokens[1]}.prefixlen`) == null) {
                                conv.set_memo(`interface.${tokens[1]}.prefixlen`, tokens[3].split('/')[1]);
                        }
                    } else {
                        af = 'ipv6';
                    }
                    val = tokens[3];
                    if (tokens[4] == 'remote') {
                        remote = tokens[5];
                    }
                    break;
            }
            if (conv.get_memo(`interface.${ifname}.${af}.address`)) {
                const k1 = conv.get_index(`interface.${ifname}.${af}.alias`);
                conv.add(`${k1}.address`, val);

            } else {
                conv.set_memo(`interface.${ifname}.${af}.address`, true);
                conv.add(`interface.${ifname}.${af}.address`, val);
                if (remote) {
                    conv.add(`interface.${ifname}.${af}.remote`, remote);
                }
            }
        },

        // interface <ifname> address は show config で出力される形式ではないが、これでだいたい動くので
        // 例外としてサポートする。
        'address': (conv, tokens) => {
            return Converter.rules['interface']['*']['add'](conv, tokens);
        },

        // https://www.seil.jp/doc/index.html#fn/interface/cmd/interface_pppac.html#bind-realm
        'bind-realm': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            tokens[3].split(",").forEach(realm_name => {
                const realm = conv.get_params('authentication.realm')[realm_name];
                const kauth = conv.get_index(`interface.${ifname}.authentication`);

                if (realm['username-suffix']) {
                    conv.add(`${kauth}.realm.suffix: ${realm['username-suffix']}`);
                }
                const user = conv.get_params(`authentication.realm.${realm_name}.user`);
                for (const name in user) {
                    const kuser = conv.get_index(`${kauth}.user`);
                    conv.add(`${kuser}.name: ${name}`);
                    conv.add(`${kuser}.password: ${user[name]['password']}`);
                    if (user[name]['framed-ip-address']) {
                        conv.add(`${kuser}.framed-ip-address: ${user[name]['framed-ip-address']}`);
                    }
                    if (user[name]['framed-ip-netmask']) {
                        conv.add(`${kuser}.framed-ip-netmask: ${user[name]['framed-ip-netmask']}`);
                    }
                }

                const url = conv.get_memo(`authentication.realm.${realm_name}.url`);
                const interval = conv.get_memo(`authentication.realm.${realm_name}.interval`);
                if (url) {
                    conv.add(`${kauth}.account-list.url: ${url}`);
                    conv.add(`${kauth}.account-list.interval: ${interval}`);
                }
            });
        },

        'bind-tunnel-protocol': (conv, tokens) => {
            // interface <pppac> bind-tunnel-protocol <protocol_config_name>,...
            const ifname = ifmap(tokens[1]);
            if (!conv.get_memo('ipsec.anonymous-l2tp-transport')) {
                conv.set_memo('ipsec.anonymous-l2tp-transport', []);
            }
            conv.get_memo('ipsec.anonymous-l2tp-transport').push(ifname);

            const protocol = conv.get_params('pppac.protocol')[tokens[3]];
            if (protocol == null) {
                // it may be unsupported protocol
                return;
            }
            if (protocol['protocol'] == 'l2tp') {
                conv.add(`interface.${ifname}.l2tp.service: enable`);

                if (protocol['authentication-method']) {
                    protocol['authentication-method'].split(',').forEach(m => {
                        const k2 = conv.get_index(`interface.${ifname}.l2tp.authentication`);
                        conv.add(`${k2}.method`, m);
                    });
                }
                const k1 = `interface.${ifname}`;
                conv.param2recipe(protocol, 'l2tp-keepalive-interval', `${k1}.l2tp.keepalive.interval`);
                conv.param2recipe(protocol, 'l2tp-keepalive-timeout', `${k1}.l2tp.keepalive.timeout`);
                conv.param2recipe(protocol, 'lcp-keepalive-interval', `${k1}.l2tp.lcp.keepalive.interval`);
                conv.param2recipe(protocol, 'lcp-keepalive-retry-interfval', `${k1}.l2tp.lcp.keepalive.retry.interval`);
                conv.param2recipe(protocol, 'mppe', `${k1}.l2tp.mppe.requirement`, val => {
                    if (val == 'require') {
                        return 'required';   // Note: we need to append the last 'd' char!
                    } else {
                        return val;
                    }
                });
                if (conv.get_memo('pppac.protocol.l2tp.require-ipsec')) {
                    conv.add(`${k1}.l2tp.ipsec.requirement`, 'required');
                }
                const preshared_key = conv.get_memo('ipsec.anonymous-l2tp-transport.preshared-key');
                if (preshared_key) {
                    conv.add(`${k1}.l2tp.ipsec.preshared-key`, preshared_key);
                }
                conv.param2recipe(protocol, 'mru', `${k1}.l2tp.mru`);
                conv.param2recipe(protocol, 'tcp-mss-adjust', `${k1}.l2tp.tcp-mss-adjust`, on2enable);
                conv.param2recipe(protocol, 'idle-timer', `${k1}.l2tp.idle-timer`);
            }
        },

        'description': 'notsupported',

        'floatlink': {
            'address-family': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.floatlink.address-family`, tokens[4]);
            },
            'dynamic-local-address': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.dynamic-local-address`, tokens[4]);
            },
            'dynamic-remote-address': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.dynamic-remote-address`, tokens[4]);
            },
            // interface <ipsec> floatlink floatlink-key { <key> | none }
            'floatlink-key': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.floatlink.key`, tokens[4]);
            },
            // interface <ipsec> floatlink ipv6 { disable | enable | system-default }
            'ipv6': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                if (tokens[4] == 'enable') {
                    conv.add(`interface.${ifname}.ipv6.forward`, 'pass');
                }
            },
            'my-address': (conv, tokens) => {
                // interface <ipsec> floatlink my-address { <interface> | <IPaddress> | none }
                const ifname = ifmap(tokens[1]);
                if (tokens[4].is_ipv4_address()) {
                    conv.notsupported('my-address <IPaddress>');
                    return;
                }
                conv.add(`interface.${ifname}.floatlink.my-address`, conv.ifmap(tokens[4]));
            },
            'my-node-id': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.floatlink.my-node-id`, tokens[4]);

                // 後で interface.${ifname}.floatlink.name-service を書き出すためにメモに入れておく。
                // my-node-id は必須キーなので、このタイミングで書く。
                conv.get_memo('floatlink.interfaces').push(ifname);
            },
            'nat-traversal': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.nat-traversal`, tokens[4]);
            },
            'peer-node-id': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.floatlink.peer-node-id`, tokens[4]);
            },
            'preshared-key': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.preshared-key`, tokens[4]);
            }
        },

        // interface <pppac> ipcp-configuration { none | <pppac_ipcp_config_name> }
        'ipcp-configuration': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            const ipcp = conv.get_params('pppac.ipcp-configuration')[tokens[3]];
            const pool = conv.get_params('pppac.pool')[ipcp['pool']];

            const address = pool['address'].split('/')[0];
            const count = 2 ** (32 - pool['address'].split('/')[1]);
            conv.add(`interface.${ifname}.ipcp.pool.100.address: ${address}`);
            conv.add(`interface.${ifname}.ipcp.pool.100.count: ${count}`);
            if (pool['type']) {
                conv.add(`interface.${ifname}.ipcp.pool.100.type: ${pool['type']}`);
            }
        },

        'l2tp': {
            'manual': 'notsupported',

            // interface <l2tp> l2tp <l2tp_name> remote-end-id <remote_end_id>
            '*': (conv, tokens) => {
                const ifname = ifmap(tokens[1]);
                conv.add(`interface.${ifname}.remote-end-id`, tokens[5]);

                const l2tp = conv.get_params('l2tp')[tokens[3]];
                conv.add(`interface.${ifname}.local-hostname`, conv.get_memo('l2tp.hostname'));
                conv.add(`interface.${ifname}.remote-hostname`, l2tp['hostname']);
                conv.add(`interface.${ifname}.local-router-id`, conv.get_memo('l2tp.router-id'));
                conv.add(`interface.${ifname}.remote-router-id`, l2tp['router-id']);
                conv.param2recipe(l2tp, 'hello-interval', `interface.${ifname}.hello-interval`);
                conv.param2recipe(l2tp, 'retry', `interface.${ifname}.retry`);
                conv.param2recipe(l2tp, 'cookie', `interface.${ifname}.cookie`, on2enable);
                conv.param2recipe(l2tp, 'password', `interface.${ifname}.password`);
            }
        },

        // interface <pppac> max-session <number_of_sessions>
        'max-session': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            conv.add(`interface.${ifname}.max-session`, tokens[3]);
        },

        'mdi': 'deprecated',

        // interface <lan> media {<media>|auto}
        'media': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            switch (ifname) {
                case 'ge0':
                    return `interface.ge0p0.media: ${tokens[3]}`
                case 'ge1':
                    return `interface.ge1p0.media: ${tokens[3]}`;
                case 'ge2':
                    return `interface.ge2.media: ${tokens[3]}`;
                default:
                    if (tokens[3] == 'auto') {
                        return [];
                    } else {
                        return 'notsupported';
                    }
            }
        },

        'mtu': 'notsupported',

        'over': {
            'lan1': [],
            '*': 'notsupported',
        },

        'ppp-configuration': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            const k1 = `interface.${ifname}`;
            const params = conv.get_params('ppp')[tokens[3]];
            conv.param2recipe(params, 'identifier', `${k1}.id`);
            conv.param2recipe(params, 'passphrase', `${k1}.password`);
            conv.param2recipe(params, 'ipcp', `${k1}.ipcp`);
            conv.param2recipe(params, 'ipcp-address', `${k1}.ipcp.address`, on2enable);
            conv.param2recipe(params, 'ipcp-dns', `${k1}.ipcp.dns`, on2enable);
            conv.param2recipe(params, 'ipv6cp', `${k1}.ipv6cp`);
            conv.param2recipe(params, 'tcp-mss', `${k1}.ipv4.tcp-mss`);
            conv.param2recipe(params, 'tcp-mss6', `${k1}.ipv6.tcp-mss`);
            conv.param2recipe(params, 'keepalive', `${k1}.keepalive`);
        },

        'queue': {
            'normal': [],
            'cbq': 'notsupported',
        },

        // interface <vlan> tag <tag> [over <lan>]
        'tag': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            conv.add(`interface.${ifname}.vid`, tokens[3]);
            var over_if = ifmap('lan0');
            if (tokens[4] == 'over') {
                over_if = ifmap(tokens[5]);
            }
            conv.add(`interface.${ifname}.over`, over_if);
        },

        // interface <lan> tcp-mss { <size> | off | auto }
        // seil3 の "off" に相当する X4 コンフィグは "none" だが、"off" は show config で表示されない。
        'tcp-mss': tokens => `interface.${ifmap(tokens[1])}.ipv4.tcp-mss: ${tokens[3]}`,
        'tcp-mss6': tokens => `interface.${ifmap(tokens[1])}.ipv6.tcp-mss: ${tokens[3]}`,

        // interface <ipsec> tunnel <start_IPaddress> <end_IPaddress>
        // interface <tunnel> tunnel dslite <aftr>
        'tunnel': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            if (tokens[3] == 'dslite') {
                conv.add(`interface.${ifname}.ipv6.dslite.aftr`, tokens[4]);
            } else {
                var af;
                if (tokens[3].is_ipv4_address()) {
                    af = 'ipv4';
                } else {
                    af = 'ipv6';
                }
                conv.set_memo(`interface.${ifname}.tunnel.source`, tokens[3]);
                conv.set_memo(`interface.${ifname}.tunnel.destination`, tokens[4]);

                // "interface.ipsec.dst" は ike peer から参照する。
                if (ifname.substr(0, 5) == 'ipsec') {
                    conv.set_memo(`interface.ipsec.dst.${tokens[4]}`, ifname);
                }

                // "interface.l2tp.tunnel"
                if (ifname.substr(0, 4) == 'l2tp') {
                    const pair = `${tokens[3]}->${tokens[4]}`;
                    conv.get_memo(`interface.l2tp.tunnel`)[pair] = ifname;
                }

                conv.add(`interface.${ifname}.${af}.source`, tokens[3]);
                conv.add(`interface.${ifname}.${af}.destination`, tokens[4]);
            }
        },

        'tunnel-end-address': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            conv.add(`interface.${ifname}.ipv4.address`, tokens[3]);
        },

        // interface <ipsec> tx-tos-set { <tos> | copy | system-default }
        'tx-tos-set': tokens => `interface.${ifmap(tokens[1])}.tx-tos-set: ${tokens[3]}`,

        // interface <ipsec> unnumbered [on <leased-interface>]
        'unnumbered': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            var lease;
            if (tokens[3] == 'on') {
                lease = ifmap(tokens[4]);
            } else {
                lease = ifmap('lan0');
            }
            conv.add(`interface.${ifname}.ipv4.address`, lease);
        },

        'user-max-session': (conv, tokens) => {
            const ifname = ifmap(tokens[1]);
            conv.add(`interface.${ifname}.user-max-session`, tokens[3]);
        },
    },
};

Converter.rules['ipsec'] = {
    // https://www.seil.jp/doc/index.html#fn/ipsec/cmd/ipsec_anonymous-l2tp-transport.html
    'anonymous-l2tp-transport': {
        'enable': (conv, tokens) => {
            const m = conv.get_memo('ipsec.anonymous-l2tp-transport');
            if (m) {
                m.forEach(ifname => {
                    conv.add(`interface.${ifname}.l2tp.ipsec.requirement: required`);
                });
            };
        },
        'preshared-key': (conv, tokens) => {
            const m = conv.get_memo('ipsec.anonymous-l2tp-transport');
            if (m) {
                m.forEach(ifname => {
                    conv.add(`interface.${ifname}.l2tp.ipsec.preshared-key: ${tokens[3]}`);
                });
            };
        },
    },

    'security-association': {
        // https://www.seil.jp/doc/index.html#fn/ipsec/cmd/ipsec_security-association.html
        'add': (conv, tokens) => {
            const sa_name = tokens[3];
            if (tokens[4] == 'tunnel-interface') {
                // ルーティングベース IPsec
                // ipsec security-association add <name> tunnel-interface <IPsec>
                //     ike <SAP_name> ah {enable|disable} esp {enable|disable}
                //     [ipv6 {pass|block}]
                //     [proxy-id-local {<IPaddress/prefixlen>|any}]
                //     [proxy-id-remote {<IPaddress/prefixlen>|any}]
                //     [proxy-id-protocol {<protocol>|any}]
                const ifname = tokens[5];
                const params = conv.read_params(null, tokens, 3, {
                    'tunnel-interface': true,
                    'ike': true,
                    'ah': true,
                    'esp': true,
                    'ipv6': `interface.${ifname}.ipv6.forward`,
                    'proxy-id-local': true,
                    'proxy-id-remote': true,
                    'proxy-id-protocol': `interface.${ifname}.ike.proposal.phase2.proxy-id.protocol`,
                });

                // ike preshared-key ...
                const dst = conv.get_memo(`interface.${ifname}.tunnel.destination`);
                if (dst) {
                    const psk = conv.get_memo('ike.preshared-key')[dst];
                    if (psk) {
                        conv.add(`interface.${ifname}.preshared-key`, psk);
                    }
                }

                // ipsec security-association proposal ...
                const kphase2 = `interface.${ifname}.ike.proposal.phase2`;
                const sap = conv.get_params('ipsec.security-association.proposal')[params['ike']];
                sap['authentication-algorithm'].split(',').forEach(alg => {
                    const ka = conv.get_index(`${kphase2}.authentication`);
                    conv.add(`${ka}.algorithm`, alg);
                });
                sap['encryption-algorithm'].split(',').forEach(alg => {
                    if (alg == 'blowfish' || alg == 'cast128' || alg == 'aes' || alg == 'null') {
                        conv.notsupported(`ipsec proposal encryption-algorithm ${alg}`);
                    }
                    const ka = conv.get_index(`${kphase2}.encryption`);
                    conv.add(`${ka}.algorithm`, alg);
                });
                const pfs_group = sap['pfs-group'];
                if (pfs_group) {
                    if (pfs_group == 'none') {
                        // do nothing
                    } else if (pfs_group == 'modp768') {
                        conv.notsupported(`dh-group ${pfs_group}`);
                    } else {
                        conv.add(`${kphase2}.pfs-group`, pfs_group);
                    }
                }
                const lifetime = sap['lifetime-of-time'];
                if (lifetime) {
                    conv.add(`${kphase2}.lifetime-of-time`, lifetime);
                }

                // ike peer add ...
                const peer = conv.get_memo(`ike.peer.address.${dst}`);
                conv.param2recipe(peer, 'initial-contact', `interface.${ifname}.ike.initial-contact`);

                const proxy_id_local = params['proxy-id-local'];
                if (proxy_id_local) {
                    if (proxy_id_local.is_ipv4_address()) {
                        conv.add(`interface.${ifname}.ike.proposal.phase2.proxy-id.ipv4.local`, proxy_id_local);
                    } else {
                        conv.add(`interface.${ifname}.ike.proposal.phase2.proxy-id.ipv6.local`, proxy_id_local);
                    }
                }

                const proxy_id_remote = params['proxy-id-remote'];
                if (proxy_id_remote) {
                    if (proxy_id_remote.is_ipv4_address()) {
                        conv.add(`interface.${ifname}.ike.proposal.phase2.proxy-id.ipv4.remote`, proxy_id_remote);
                    } else {
                        conv.add(`interface.${ifname}.ike.proposal.phase2.proxy-id.ipv6.remote`, proxy_id_remote);
                    }
                }

            } else {
                // ipsec security-association add <name> { tunnel | transport }
                //     { <start_IPaddress> <end_IPaddress> | <start_Interface> <end_IPaddress> | dynamic | auto }
                //     ike <SAP_name> ah { enable | disable } esp { enable | disable }
                const params = {};
                const sa_idx = conv.get_saindex();
                const k1 = `ipsec.security-association.${sa_idx}`;

                params['idx'] = sa_idx;

                var idx;
                if (tokens[4] == 'tunnel') {
                    // tunnel モード IPsec
                    idx = 5;
                    switch (tokens[5]) {
                        case 'dynamic':
                            conv.add(`${k1}.address-type`, 'dynamic');
                            idx += 1;
                            break;
                        case 'auto':
                            conv.notsupported('security-association auto');
                            break;
                        default:
                            params['src'] = tokens[5];
                            params['dst'] = tokens[6];
                            conv.add(`${k1}.address-type`, 'static');
                            conv.add(`${k1}.local-address`, tokens[5]);
                            conv.add(`${k1}.remote-address`, tokens[6]);
                            idx += 2;
                            break;
                    }
                } else if (tokens[4] == 'transport') {
                    // X4 では transport モード IPsec は L2TPv3 でしか使えない。
                    const src = tokens[5];
                    const dst = tokens[6];
                    const l2tpif = conv.get_memo('interface.l2tp.tunnel')[`${src}->${dst}`];
                    if (l2tpif == null) {
                        conv.notsupported(`ipsec security-association mode: ${tokens[4]}`);
                        return;
                    }
                    params['src'] = src;
                    params['dst'] = dst;
                    idx = 7;
                }

                if (tokens[idx] != 'ike') {
                    conv.notsupported('manual-key ipsec');
                    return;
                }
                params['ike'] = tokens[idx + 1];

                if (tokens[idx + 2] == 'ah') {  // "ah disable" は表示されないため enable に決まっている。
                    conv.notsupported('IPsec AH');
                    return;
                }
                // IKE 利用の場合は ESP は必ず enable なのでチェックしなくて良い。

                conv.set_memo(`ipsec.security-association.${sa_name}`, params);
            }
        },

        // ipsec security-association proposal add <name> ...
        //     authentication-algorithm { hmac-md5 | hmac-sha1 | hmac-sha256 | hmac-sha384 | hmac-sha512 },...
        //     encryption-algorithm { 3des | des | blowfish | cast128 | aes | aes128 | aes192 | aes256, null },...
        //     lifetime-of-time { <time> | system-default }]
        //     [pfs-group { modp768 | modp1024 | modp1536 | modp2048 | modp3072 | modp4096 | modp6144 | modp8192 | none }]
        'proposal': (conv, tokens) => {
            conv.read_params('ipsec.security-association.proposal', tokens, 4, {
                'authentication-algorithm': true,
                'encryption-algorithm': true,
                'lifetime-of-time': true,
                'pfs-group': true,
            });
        }
    },

    // ipsec security-policy add <name> security-association <SA_name>
    //     src { <IPaddress>[/<prefixlen>] | <interface> | any}
    //     dst { <IPaddress>[/<prefixlen>] | any }
    //     [srcport { <port> | any }] [dstport { <port> | any }] [protocol <protocol>]
    //     [enable | disable]
    'security-policy': (conv, tokens) => {
        const k1 = conv.get_index('ipsec.security-policy');
        const params = conv.read_params('ipsec.security-policy', tokens, 3, {
            'security-association': true,
            'src': true,
            'dst': true,
            'srcport': true,
            'dstport': true,
            'protocol': true,
            'enable': false,
            'disable': 'notsupported'
        });
        const sa_name = params['security-association'];
        const sa = conv.get_memo(`ipsec.security-association.${sa_name}`);
        if (sa == null) {
            conv.badconfig(`ipsec security-association ${sa_name} is not properly configured`);
            return;
        }

        const sap_name = sa['ike'];

        const sap = conv.get_params('ipsec.security-association.proposal')[sap_name];

        // L2TPv3/IPsec 設定は特別扱い。
        const srcaddr = params['src'].replace(/\/32/, '');
        const dstaddr = params['dst'].replace(/\/32/, '');
        const srcdst = `${srcaddr}->${dstaddr}`;
        const l2tpif = conv.get_memo('interface.l2tp.tunnel')[srcdst];
        if (params['protocol'] == '115' && l2tpif &&
            sa['src'] == srcaddr && sa['dst'] == dstaddr) {
            const psk = conv.get_memo('ike.preshared-key')[dstaddr];
            if (psk) {
                conv.add(`interface.${l2tpif}.ipsec-preshared-key`, psk);
            }
            const ikepeer = conv.get_memo(`ike.peer.address.${dstaddr}`);
            if (ikepeer) {
                // 注意: SEIL の nat-traversal はデフォルトで disable だが X4 の ipsec-nat-traversal は
                // デフォルトで enable。また、X4 には ipsec-nat-traversal: disable の設定が無い。
                // よって、
                //    nat-traversal enable  -> ipsec-nat-traversal: enable
                //    nat-traversal force   -> ipsec-nat-traversal: force
                //    nat-traversal disable -> 'deprecated'
                //    (none)                -> (none)
                //  とする。旧 SEIL で nat-traversal を設定されていないコンフィグは X4 には変換できないため
                //  正しくは 'deprecated' 警告を出すべきとも考えられるが、変換ログが見にくくなるためやめておく。
                var natt = ikepeer['nat-traversal'];
                if (natt == 'enable') {
                    conv.add(`interface.${l2tpif}.ipsec-nat-traversal`, 'enable');
                } else if (natt == 'force') {
                    conv.add(`interface.${l2tpif}.ipsec-nat-traversal`, 'force');
                } else if (natt == 'disable') {
                    conv.deprecated('ike nat-traversal disable');
                }
            }
            return;
        }

        //
        // ipsec.security-asociation
        //
        conv.add(`${k1}.security-association`, sa['idx']);

        const kprop = `${k1}.ike.proposal`;
        sap['authentication-algorithm'].split(',').forEach(alg => {
            const ka = conv.get_index(`${kprop}.authentication`);
            conv.add(`${ka}.algorithm`, alg);
        });
        sap['encryption-algorithm'].split(',').forEach(alg => {
            if (alg == 'blowfish' || alg == 'cast128' || alg == 'aes' || alg == 'null') {
                conv.notsupported(`ipsec proposal encryption-algorithm ${alg}`);
            }
            const ka = conv.get_index(`${kprop}.encryption`);
            conv.add(`${ka}.algorithm`, alg);
        });
        if (sa['lifetime-of-time']) {
            conv.add(`${kprop}.lifetime-of-time`, sa['lifetime-of-time']);
        }
        const pfs_group = sa['pfs-group'];
        if (pfs_group) {
            if (pfs_group == 'modp768') {
                conv.notsupported(`dh-group ${pfs_group}`);
            } else {
                conv.add(`${kprop}.pfs-group`, sa['pfs-group']);
            }
        }

        //
        // ipsec.security-policy
        //
        conv.param2recipe(params, 'src', `${k1}.source.address`);
        conv.param2recipe(params, 'dst', `${k1}.destination.address`);
        conv.param2recipe(params, 'srcport', `${k1}.source.port`);
        conv.param2recipe(params, 'dstport', `${k1}.destination.port`);
        conv.param2recipe(params, 'protocol', `${k1}.protocol`);
    },
};

Converter.rules['l2tp'] = {
    'add': (conv, tokens) => {
        conv.read_params('l2tp', tokens, 2, {
            'hostname': true,
            'router-id': true,
            'password': true,
            'cookie': true,
            'retry': true,
            'hello-interval': true,
            'compatibility': 'notsupported'
        });
    },
    'hostname': (conv, tokens) => {
        conv.set_memo('l2tp.hostname', tokens[2]);
    },
    'router-id': (conv, tokens) => {
        conv.set_memo('l2tp.router-id', tokens[2]);
    }
};

Converter.rules['macfilter'] = {
    // https://www.seil.jp/doc/index.html#fn/macfilter/cmd/macfilter.html#add
    'add': (conv, tokens) => {
        // macfilter add <name> [action { block | pass }] [on { <lan> | <vlan> | bridge }]
        //     src { any | <MACaddress> | <URL> interval <time> }
        //     [logging { on | off }]
        //     [block-dhcp { on | off }]
        const params = conv.read_params('macfilter', tokens, 2, {
            'action': true,
            'logging': true,
            'on': true,
            'src': true,
            'interval': true,
            'block-dhcp': 'notsupported'
        });
        var k1;
        if (params['interval']) {  // URL 指定の場合は必ず interval パラメタがある。
            k1 = conv.get_index('macfilter.entry-list');
            conv.param2recipe(params, 'src', `${k1}.url`);
            conv.param2recipe(params, 'interval', `${k1}.update-interval`);
        } else {
            k1 = conv.get_index('macfilter.entry');
            conv.param2recipe(params, 'src', `${k1}.address`);
        }
        conv.param2recipe(params, 'on', `${k1}.interface`, ifmap);
        conv.param2recipe(params, 'action', `${k1}.action`);
        conv.param2recipe(params, 'logging', `${k1}.logging`);
    }
};


Converter.rules['nat'] = {
    'bypass': {
        'add': (conv, tokens) => {
            // nat bypass add <private_IPv4address> <global_IPv4address> [interface <interface>]
            const k1 = conv.get_index('nat.ipv4.bypass');
            conv.add(`${k1}.private`, tokens[3]);
            conv.add(`${k1}.global`, tokens[4]);
            conv.add(`${k1}.interface`, conv.natifname(tokens[6]));
        },
    },

    'logging': {
        'off': [],
        '*': 'notsupported',
    },

    'dynamic': {
        'add': {
            // https://www.seil.jp/doc/index.html#fn/nat/cmd/nat_dynamic.html#add_global
            'global': (conv, tokens) => {
                // nat dynamic add global <global_IPaddress> [interface <interface>]
                const ifname = conv.natifname(tokens[6]);
                const m = `nat.dynamic.global.${ifname}`;
                const globals = conv.get_memo(m);
                if (globals) {
                    globals.push(tokens[4]);
                } else {
                    conv.set_memo(m, [ tokens[4] ]);
                }
            },

            'private': (conv, tokens) => {
                // nat dynamic add private <private_IPaddress> [interface <interface>]
                const ifname = conv.natifname(tokens[6]);
                const m = `nat.dynamic.global.${ifname}`;
                const k1 = conv.get_index('nat.ipv4.dnat');
                conv.get_memo(m).forEach(g => {
                    const k2 = conv.get_index(`${k1}.global`);
                    conv.add(`${k2}.address`, g);
                });
                conv.add(`${k1}.private.100.address: ${tokens[4]}`);
            },
        },
    },

    // https://www.seil.jp/doc/index.html#fn/nat/cmd/nat_napt.html
    // https://www.seil.jp/sx4/doc/sa/nat/config/nat.ipv4.napt.html
    'napt': {
        'add': {
            'global': (conv, tokens) => {
                // nat napt add global <global_IPaddress> [interface <interface>]
                //
                // Note: "add" というキーワードを使っているため一見複数行書けるように見えるが、
                // 実は "nat dyamic add global" はひとつしか設定できない(二つ目を add する
                // と一つ目が消える!)ので、"interface" パラメタは無視して良い(というか完全には
                // 変換できない)。
                conv.add(`nat.ipv4.napt.global`, tokens[4]);
            },

            'private': (conv, tokens) => {
                // nat napt add private <private_IPaddress> [interface <interface>]
                const k1 = conv.get_index('nat.ipv4.napt');
                conv.add(`${k1}.private`, tokens[4]);
                conv.add(`${k1}.interface`, conv.natifname(tokens[6]));
            },
        },
    },

    'option': {
        'port-assignment': tokens => `nat.ipv4.option.port-assignment: ${tokens[3]}`,
    },

    'proxy': {
        'sip': {
            'add': {
                'port': (conv, tokens) => {
                    const k = conv.get_index('nat.proxy.sip');
                    conv.add(`${k}.protocol: ${tokens[7]}`);
                    conv.add(`${k}.port: ${tokens[5]}`);
                }
            }
        },
    },

    'reflect': {
        'add': {
            'interface': (conv, tokens) => {
                // nat reflect add interface <interface>
                const k1 = conv.get_index('nat.ipv4.reflect')
                conv.add(`${k1}.interface: ${ifmap(tokens[4])}`);
            }
        }
    },

    'session': {
        // nat session restricted-per-ip { <max> | system-default }
        'restricted-per-ip': tokens => `nat.ipv4.option.limit.session-per-ip: ${tokens[3]}`,

        // nat session restricted-per-private-ip { <max> | system-default }
        'restricted-per-private-ip': tokens => `nat.ipv4.option.limit.session-per-private-ip: ${tokens[3]}`
    },

    // https://www.seil.jp/doc/index.html#fn/nat/cmd/nat_static.html#add
    'static': {
        'add': (conv, tokens) => {
            // nat static add <private_IPaddress> <global_IPaddress> [interface <interface>]
            const k1 = conv.get_index('nat.ipv4.snat');
            conv.add(`${k1}.private`, tokens[3]);
            conv.add(`${k1}.global`, tokens[4]);
            conv.add(`${k1}.interface`, conv.natifname(tokens[6]));
        },
    },

    'snapt': (conv, tokens) => {

        // listen の有無によって forward のパラメタが1つか2つか判断できる。
        // disable の snapt 設定は recipe では表現できないため変換しない。

        const k1 = conv.get_index('nat.ipv4.snapt');
        var idx;
        if (tokens[5] == 'listen') {
            // nat snapt add protocol {tcp|udp|tcpudp} listen <listen_port>
            //    forward <IPv4address> <forward_port> { enable | disable } interface <interface>
            if (tokens[10] == 'disable') {
                return;
            }
            conv.add(`${k1}.protocol`, tokens[4]);
            conv.add(`${k1}.listen.port`, tokens[6]);
            conv.add(`${k1}.forward.address`, tokens[8]);
            conv.add(`${k1}.forward.port`, tokens[9]);
            conv.add(`${k1}.interface`, conv.natifname(tokens[12]));
        } else {
            // nat snapt add protocol <protocol>
            //    forward <IPv4address> { enable | disable } interface <interface>
            if (tokens[7] == 'disable') {
                return;
            }
            conv.add(`${k1}.protocol`, tokens[4]);
            conv.add(`${k1}.forward.address`, tokens[6]);
            conv.add(`${k1}.interface`, conv.natifname(tokens[9]));
        }
    },

    // https://www.seil.jp/doc/index.html#fn/nat/cmd/nat_timeout.html
    'timeout': {
        '*': tokens => `nat.ipv4.timeout: ${tokens[2]}`,

        'dynamic': 'deprecated',

        // nat timeout protocol { tcp-synonly | tcp-established | udp | icmp } { <time> | system-default }
        'protocol': tokens => `nat.ipv4.timeout.${tokens[3]}: ${tokens[4]}`,
    },

    // https://www.seil.jp/doc/index.html#fn/nat/cmd/nat_upnp.html
    'upnp': {
        'interface': (conv, tokens) => {
            conv.add('upnp.interface', conv.ifmap(tokens[3]));
        },
        'on':  'upnp.service: enable',
        'off': 'upnp.service: disable',
        'timeout': {
            'type': tokens => `upnp.timeout-type: ${tokens[4]}`,
            '*':    tokens => `upnp.timeout: ${tokens[3]}`,
        }
    },
};

Converter.rules['nat6'] = {
    'add': (conv, tokens) => {
        // nat6 add <name> type {ngn|transparent} internal <prefix/prefixlen>
        //     external <prefix/prefixlen> interface <interface>
        //     [ndproxy { on | off | system-default }]
        const k1 = conv.get_index('nat.ipv6');
        conv.add(`${k1}.type`, tokens[4]);
        conv.add(`${k1}.internal`, tokens[6]);
        conv.add(`${k1}.external`, tokens[8]);
        conv.add(`${k1}.interface`, conv.ifmap(tokens[10]));
        if (tokens[11] == 'ndproxy') {
            conv.add(`${k1}.ndproxy`, on2enable(tokens[12]));
        }
    },
};

Converter.rules['ntp'] = {
    // https://www.seil.jp/doc/index.html#fn/ntp/cmd/ntp.html
    // https://www.seil.jp/sx4/doc/sa/ntp/config/ntp.client.html
    'disable': 'ntp.service: disable',

    'enable': (conv, tokens) => {
        conv.add('ntp.service', 'enable');
        conv.defer((conv) => {
            if (conv.get_memo('ntp.mode') != 'client') {
                conv.add('ntp.server', 'enable');
            } else {
                conv.add('ntp.server', 'disable');
            }
        })
    },

    // ntp mode { client | server | system-default }
    'mode': (conv, tokens) => {
        conv.set_memo('ntp.mode', tokens[2]);
    },

    'peer': 'notsupported',

    // ntp server add {<IPaddress>|dhcp6 } [prefer {on|off}]
    'server': (conv, tokens) => {
        const k1 = conv.get_index('ntp.client');
        conv.add(`${k1}.address`, tokens[3]);
        if (tokens[4] == 'prefer') {
            conv.notsupported('ntp prefer parameter');
        }
    },
};

Converter.rules['option'] = {
    'ip': {
        'accept-redirect': 'notsupported',
        'broadcast-icmp': 'notsupported',
        'directed-broadcast': tokens => `option.ipv4.directed-broadcast.service: ${on2enable(tokens[3])}`,
        'fragment-requeueing': tokens => `option.ipv4.fragment-requeueing.service: ${on2enable(tokens[3])}`,
        'mask-reply': 'deprecated',
        'monitor-linkstate': tokens => `option.ipv4.monitor-linkstate.service: ${on2enable(tokens[3])}`,
        'multipath-selection': tokens => `option.ipv4.multipath-selection.service: ${on2enable(tokens[3])}`,
        'redirects': tokens => `option.ipv4.send-icmp-redirect.service: ${on2enable(tokens[3])}`,
        'unicast-rpf': 'notsupported',
        'update-connected-route': tokens => `option.ipv4.update-connected-route.service: ${on2enable(tokens[3])}`,
    },

    'ipv6': {
        'avoid-path-mtu-discovery': 'deprecated',
        'monitor-linkstate': tokens => `option.ipv6.monitor-linkstate.service: ${on2enable(tokens[3])}`,
        'redirects': tokens => `option.ipv6.send-icmp-redirect.service: ${on2enable(tokens[3])}`,
        'unicast-rpf': 'notsupported',
        'update-connected-route': tokens => `option.ipv6.update-connected-route.service: ${on2enable(tokens[3])}`,
    },

    'statistics': 'notsupported',
};

Converter.rules['ppp'] = {
    'add': (conv, tokens) => {
        const params = conv.read_params('ppp', tokens, 2, {
            'ipcp': true,
            'ipv6cp': true,
            'keepalive': true,
            'ipcp-address': true,
            'ipcp-dns': true,
            'acname': 'notsupported',
            'servicename': 'notsupported',
            'authentication-method': true,
            'identifier': true,
            'passphrase': true,
            'tcp-mss': true,
            'tcp-mss6': true,
            'auto-connect': 'notsupported',
            'idle-timer': 'notsupported',
            'mppe': 'notsupported'
        });
        if (params['authentication-method'] != 'auto') {
            conv.notsupported(`ppp authentication-method ${params['authentication-method']}`);
        }
    },
};

Converter.rules['pppac'] = {
    // https://www.seil.jp/doc/index.html#fn/pppac/cmd/pppac_ipcp-configuration.html
    'ipcp-configuration': {
        'add': (conv, tokens) => {
            conv.read_params('pppac.ipcp-configuration', tokens, 3, {
                'pool': true,
                'dns-use-forwarder': value => {
                    if (value == 'on') {
                        return new Error('notsupported');
                    } else {
                        return value;
                    }
                },
                'dns-primary': true,
                'dns-secondary': true,
                'wins-server-primary': true,
                'wins-server-secondary': true,
                'accept-user-address': true,
            });
        },
    },
    'option': {
        'session-limit': 'notsupported',
    },
    'pool': {
        'add': (conv, tokens) => {
            conv.read_params('pppac.pool', tokens, 3, {
                'address': true,
                'type': true,
            });
        },
    },
    'protocol': {
        'l2tp': {
            'add': (conv, tokens) => {
                const params = conv.read_params('pppac.protocol', tokens, 4, {
                    'accept-interface': true,
                    'authentication-method': true,
                    'accept-dialin': true,
                    'authentication-timeout': true,
                    'mppe' :true,
                    'mppe-key-length': true,
                    'mppe-key-change': true,
                    'l2tp-keepalive-interval': true,
                    'l2tp-keepalive-timeout': true,
                    'lcp-keepalive': true,
                    'lcp-keepalive-interval': true,
                    'lcp-keepalive-retry-interval': true,
                    'lcp-keepalive-max-retries': true,
                    'tcp-mss-adjust': true,
                    'mru': true,
                    'idle-timer': true,
                });
                params['protocol'] = 'l2tp';


            },
            // pppac protocol l2tp require-ipsec { on | off | system-default }
            'require-ipsec': (conv, tokens) => {
                conv.set_memo('pppac.protocol.l2tp.require-ipsec', (tokens[4] == 'on'));
            }
        },
        'pppoe': 'notsupported',
        'pptp': 'notsupported',
        'sstp': 'notsupported',
    }
};

Converter.rules['proxyarp'] = {
    // proxyarp add <name> interface <interface> address { <IPv4address> | <IPv4address_range> }
    //     [mac-address { <MACaddress> | auto | system-default }]
    'add': (conv, tokens) => {
        if (! conv.get_memo('proxyarp.enable')) {
            return;
        }
        const k1 = conv.get_index('proxyarp');
        conv.add(`${k1}.interface`, conv.ifmap(tokens[4]));
        conv.add(`${k1}.ipv4-address`, tokens[6]);
        if (tokens[7] == 'mac-address') {
            conv.add(`${k1}.mac-address`, tokens[8]);
        }
    },
    'disable': [],
    'enable': (conv, tokens) => {
        conv.set_memo('proxyarp.enable', true);
    },
};

Converter.rules['resolver'] = {
    // resolver address add { <IPaddress> | ipcp | ipcp-auto | dhcp | dhcp6 }
    'address': (conv, tokens) => {
        const k1 = conv.get_index('resolver');
        if (tokens[3] == 'ipcp-auto') {
            conv.notsupported('resolver ipcp-auto');
            return;
        }
        conv.add(`${k1}.address`, tokens[3]);
    },
    'disable': 'resolver.service: disable',
    'domain': tokens => `resolver.domain: ${tokens[2]}`,
    'enable': 'resolver.service: enable',

    // resolver host-database add <hostname> address <IPaddress>[,<IPaddress>]...
    'host-database': (conv, tokens) => {
        tokens[5].split(",").forEach(addr => {
            const k1 = conv.get_index('resolver.host-database');
            conv.add(`${k1}.hostname`, tokens[3]);
            conv.add(`${k1}.address`, addr);
        });
    },

    'order': 'notsupported'
};

Converter.rules['route'] = {
    // https://www.seil.jp/sx4/doc/sa/route/config/route.ipv4.html
    'add': (conv, tokens) => {
        // route add {<IPv4address>[/<prefixlen>]|default}
        //     {<gateway_IPv4address>|<interface>|dhcp|discard}
        //     [distance <distance>] [metric <metric>]
        //     [keepalive {on|off} [target <IPv4address>] [send-interval <interval>]
        //         [timeout <timeout>] [down-count <count>] [up-count <count>] [src <IPv4address>]]
        const k1 = conv.get_index('route.ipv4');
        conv.add(`${k1}.destination`, tokens[2]);
        conv.add(`${k1}.gateway`, tokens[3]);
        const params = conv.read_params(null, tokens, 3, {
            'distance': true,
            'metric': 'deprecated',
            'keepalive': true,
            'target': true,
            'send-interval': true,
            'timeout': true,
            'down-count': true,
            'up-count': true,
            'src': true,
        });
        conv.param2recipe(params, 'distance',      `${k1}.distance`);
        conv.param2recipe(params, 'keepalive',     `${k1}.keepalive.service`, on2enable);
        conv.param2recipe(params, 'target',        `${k1}.keepalive.target`);
        conv.param2recipe(params, 'send-interval', `${k1}.keepalive.send-interval`);
        conv.param2recipe(params, 'timeout',       `${k1}.keepalive.timeout`);
        conv.param2recipe(params, 'down-count',    `${k1}.keepalive.down-count`);
        conv.param2recipe(params, 'up-count',      `${k1}.keepalive.up-count`);
        conv.param2recipe(params, 'src',           `${k1}.keepalive.source.address`);
    },
    'dynamic': {
        'auth-key': (conv, tokens) => {
            // route dynamic auth-key add <name> type plain-text password <password>
            // route dynamic auth-key add <name> type md5 keyid <keyid> password <password>
            const m = `route.auth-key.${tokens[4]}`;
            conv.read_params('route.auth-key', tokens, 4, {
                'type': true,
                'keyid': true,
                'password': true,
            });
        },

        'bgp': {
            'disable': [],

            'enable': (conv, tokens) => {
                conv.set_memo('bgp.enable', true);
            },

            'my-as-number': (conv, tokens) => {
                // route dynamic bgp my-as-number <as-number>
                if (! conv.get_memo('bgp.enable')) { return; }
                conv.add('bgp.my-as-number', tokens[4]);
            },

            // route dynamic bgp neighbor add <neighbor_IPv4address> remote-as <as-number>
            //     [hold-timer <hold_time>] [weight <weight>]
            //     [in-route-filter <route-filter-name>[,<route-filter-name>...]]
            //     [out-route-filter <route-filter-name>[,<route-filter-name>...]]
            //     [authentication md5 <password>] [disable | enable]
            'neighbor': (conv, tokens) => {
                if (tokens[tokens.length - 1] == 'disable') {
                    return;
                }
                const k1 = conv.get_index('bgp.neighbor');
                const params = conv.read_params(null, tokens, 5, {
                    'remote-as': `${k1}.remote-as`,
                    'hold-timer': `${k1}.hold-timer`,
                    'weight': `${k1}.weight`,
                    'authentication': false,
                    'md5': `${k1}.authentication.password`,
                    'in-route-filter': true,
                    'out-route-filter': true,
                    'enable': false,
                });
                conv.param2recipe(params, '*NAME*', `${k1}.address`);
                // XXX: route-filters
            },

            'network': (conv, tokens) => {
                // route dynamic bgp network add <network_IPv4address/prefixlen>
                const k1 = conv.get_index('bgp.network');
                conv.add(`${k1}.prefix`, tokens[5]);
            },

            'router-id': (conv, tokens) => {
                // route dynamic bgp router-id <router-id>
                if (! conv.get_memo('bgp.enable')) { return; }
                conv.add('bgp.router-id', tokens[4]);
            },
        },

        // https://www.seil.jp/doc/index.html#fn/route/cmd/route_dynamic_ospf.html
        'ospf': {
            'administrative-distance': {
                // route dynamic ospf administrative-distance
                //     { external | inter-area | intra-area } { <number> | system-default }
                'external': tokens => `ospf.administrative-distance.external: ${tokens[5]}`,
                'inter-area': tokens => `ospf.administrative-distance.external: ${tokens[5]}`,
                'intra-area':  tokens => `ospf.administrative-distance.external: ${tokens[5]}`,
            },
            'area': (conv, tokens) => {
                // route dynamic ospf area add <area-id> [range <IPaddress/prefixlen>]
                //     [stub {disable|enable}] [no-summary {on|off}] [default-cost <cost>]
                const params = conv.read_params(null, tokens, 5, {
                    'range': true,
                    'stub': true,
                    'no-summary': true,
                    'default-cost': true,
                });
                const k1 = conv.get_index('ospf.area');
                conv.param2recipe(params, '*NAME*', `${k1}.id`);
                conv.param2recipe(params, 'range', `${k1}.range`);
                conv.param2recipe(params, 'stub', `${k1}.type`, val => {
                    return (val == 'enable') ? 'stub' : 'normal';
                });
                conv.param2recipe(params, 'no-summary', `${k1}.stub.no-summary`, on2enable);
                conv.param2recipe(params, 'default-cost', `${k1}.stub.default-cost`);
            },

            // route dynamic ospf default-route-originate { disable | enable
            //    [metric <metric>] [metric-type <metric-type>] }
            'default-route-originate': {
                'disable': [],
                'enable': (conv, tokens) => {
                    conv.add('ospf.default-route-originate.originate', 'enable');
                    conv.read_params(null, tokens, 4, {
                        'metric': 'ospf.default-route-originate.set.metric',
                        'metric-type': 'ospf.default-route-originate.set.metric-type',
                    });
                },
            },
            'disable': [],
            'enable': (conv, tokens) => {
                conv.set_memo('ospf.enable', true);
            },
            'link': (conv, tokens) => {
                // route dynamic ospf link add <interface> area <area-id>
                //     [authentication auth-key <key-name>] [cost <cost>]
                //     [hello-interval <hello-interval>] [dead-interval <dead-interval>]
                //     [retransmit-interval <retransmit-interval>] [transmit-delay <transmit-delay>]
                //     [priority <priority>] [passive-interface {on|off}]
                const k1 = conv.get_index('ospf.link');
                const params = conv.read_params(null, tokens, 5, {
                    'area': `${k1}.area`,
                    'authentication': false,  // ignore it
                    'auth-key': true,
                    'cost': `${k1}.cost`,
                    'hello-interval': `${k1}.hello-interval`,
                    'dead-interval': `${k1}.dead-interval`,
                    'retransmit-interval': `${k1}.retransmit-interval`,
                    'transmit-delay': `${k1}.transmit-delay`,
                    'priority': `${k1}.priority`,
                    'passive-interface': {
                        key: `${k1}.passive-interface`,
                        fun: on2enable,
                    },
                });
                if (params['auth-key']) {
                    const keyname = params['auth-key'];
                    const akey = conv.get_params('route.auth-key')[keyname];
                    if (akey['type'] == 'plain-text') {
                        conv.add(`${k1}.authentication.type`, 'plain-text');
                        conv.add(`${k1}.authentication.plain-text.password`, akey['password']);
                    } else if (akey['type' == 'md5']) {
                        conv.add(`${k1}.authentication.type`, 'md5');
                        conv.add(`${k1}.authentication.md5.key-id`, akey['keyid']);
                        conv.add(`${k1}.authentication.md5.secret-key`, akey['password']);
                    }
                }
            },

            'nexthop-calculation-type': 'notsupported',

            'router-id': (conv, tokens) => {
                // route dynamic ospf router-id { <my-router-id> | none }
                if (! conv.get_memo('ospf.enable')) { return; }
                conv.add('ospf.router-id', tokens[4]);
            },
        },

        'pim-sparse': {
            'disable': [],
            '*': 'notsupported',
        },

        // route dynamic redistribute { static-to-rip | ospf-to-rip | bgp-to-rip }
        //     { disable | enable [metric <metric>]
        //     [route-filter <route-filter-name>[,<route-filter-name>...]] }
        'redistribute': {
            'bgp-to-rip': tokens => `rip.redistribute-from.bgp.redistribute: ${tokens[4]}`,

            'bgp-to-ospf': (conv, tokens) => {
                if (conv.get_memo('ospf.enable')) {
                    conv.add('ospf.redistribute-from.bgp.redistribute', tokens[4]);
                }
            },

            'connected-to-rip': tokens => `rip.redistribute-from.connected.redistribute: ${tokens[4]}`,

            'connected-to-ospf': (conv, tokens) => {
                if (conv.get_memo('ospf.enable')) {
                    conv.add('ospf.redistribute-from.connected.redistribute', tokens[4]);
                }
            },

            'ospf-to-rip': tokens => `rip.redistribute-from.ospf.redistribute: ${tokens[4]}`,

            'rip-to-ospf': (conv, tokens) => {
                // route dynamic redistribute rip-to-ospf {disable|enable}
                //     [metric <metric>] [metric-type <metric-type>]
                //     [route-filter <route-filter-name>[,<route-filter-name>...]]
                if (conv.get_memo('ospf.enable')) {
                    conv.add('ospf.redistribute-from.rip.redistribute', tokens[4]);
                    const params = conv.read_params(null, tokens, 3, {
                        'disable': 0,
                        'enable': 0,
                        'metric': 'ospf.redistribute-from.rip.set.metric',
                        'metric-type': 'ospf.redistribute-from.rip.set.metric-type',
                        'route-filter': true,
                    });
                    params['route-filter'].split(',').forEach(name => {
                        const rf = conv.get_params('route-filter.ipv4')[name];
                        const k1 = conv.get_index('ospf.redistribute-from.rip.filter');
                        conv.param2recipe(rf, 'interface', `${k1}.match.interface`, conv.ifmap);
                        conv.param2recipe(rf, 'network', `${k1}.match.prefix`, val => `${val}-32`);
                        conv.param2recipe(rf, 'set-metric', `${k1}.set.metric`);
                        conv.param2recipe(rf, 'set-metric-type', `${k1}.set.metric-type`);
                        if (rf['pass']) {
                            conv.add(`${k1}.action`, 'pass');
                        }
                        if (rf['block']) {
                            conv.add(`${k1}.action`, 'block');
                        }
                    });
                }
            },

            'static-to-rip': tokens => `rip.redistribute-from.static.redistribute: ${tokens[4]}`,

            'static-to-ospf': (conv, tokens) => {
                if (conv.get_memo('ospf.enable')) {
                    conv.add('ospf.redistribute-from.static.redistribute', tokens[4]);
                }
            },
        },

        'rip': {
            'default-route-originate': 'notsupported',

            'disable': [],

            'enable': (conv, tokens) => {
                conv.set_memo('rip.enable', true);
            },

            'expire-timer': tokens => `rip.timer.expire: ${tokens[4]}`,

            'garbage-collection-timer': tokens => `rip.timer.garbage-collection: ${tokens[4]}`,

            'interface': {
                '*': {
                    'authentication': {
                        'auth-key': (conv, tokens) => {
                            // route dynamic rip interface <interface>
                            //     authentication auth-key <key-name>
                            const ifname = ifmap(tokens[4]);
                            const k1 = conv.get_memo(`rip.interface.${ifname}`);
                            if (k1 == null) {
                                // route dynamic rip interface <if> disable
                                return;
                            }
                            if (!conv.get_memo(`rip.interface.${ifname}.authentication`)) {
                                // route dynamic rip interface <if> authentication disable
                                return;
                            }
                            const keyname = tokens[7];
                            const akey = conv.get_params('route.auth-key')[keyname];
                            if (akey['type'] == 'plain-text') {
                                conv.add(`${k1}.authentication.type`, 'plain-text');
                                conv.add(`${k1}.authentication.plain-text.password`, akey['password']);
                            } else if (akey['type' == 'md5']) {
                                conv.add(`${k1}.authentication.type`, 'md5');
                                conv.add(`${k1}.authentication.md5.key-id`, akey['keyid']);
                                conv.add(`${k1}.authentication.md5.secret-key`, akey['password']);
                            }
                        },

                        'disable': [],

                        'enable': (conv, tokens) => {
                            const ifname = ifmap(tokens[4]);
                            conv.set_memo(`rip.interface.${ifname}.authentication`, true);
                        },
                    },

                    'disable': [],

                    'enable': (conv, tokens) => {
                        const ifname = ifmap(tokens[4]);
                        conv.set_memo(`rip.interface.${ifname}`, conv.get_index('rip.interface'));
                    },

                    'listen-only': (conv, tokens) => {
                        const ifname = ifmap(tokens[4]);
                        const k1 = conv.get_index('rip.interface');
                        conv.set_memo(`rip.interface.${ifname}`, k1);
                        conv.add(`${k1}.mode`, 'listen-only');
                    },

                    'route-filter': (conv, tokens) => {
                        // route dynamic rip interface <interface>
                        //     route-filter {in|out} <route-filter-name>[,<route-filter-name>...]
                        // XXX: notyet
                    },

                    'supply-only': (conv, tokens) => {
                        const ifname = ifmap(tokens[4]);
                        const k1 = conv.get_index('rip.interface');
                        conv.set_memo(`rip.interface.${ifname}`, k1);
                        conv.add(`${k1}.mode`, 'supply-only');
                    },

                    'version': (conv, tokens) => {
                        // route dynamic rip interface <interface>
                        //     version { ripv1 | ripv2 | ripv2-broadcast }
                        const ifname = ifmap(tokens[4]);
                        const k1 = conv.get_memo(`rip.interface.${ifname}`);
                        if (k1 == null) {
                            return;
                        }
                        conv.add(`${k1}.version`, tokens[6]);
                    },
                }
            },

            'update-timer': tokens => `rip.timer.update: ${tokens[4]}`,
        },

        'route-filter': (conv, tokens) => {
            // route dynamic route-filter add <filter-name>
            //     [network <IPaddress>[/<prefixlen>]
            //         [prefix <prefixlen>-<prefixlen> | exact-match] ]
            //     [interface <interface>] [metric <number>] { pass | block }
            //     [set-as-path-prepend <as-number>[,<as-number>...]]
            //     [set-metric <number>] [set-metric-type <number>] [set-weight <number>]
            conv.read_params('route-filter.ipv4', tokens, 4, {
                'network': true,
                'prefix': true,
                'exact-match': 0,
                'interface': true,
                'metric': true,
                'pass':  0,
                'block': 0,
                'set-as-path-prepend': true,
                'set-metric': true,
                'set-metric-type': true,
                'set-weight': true,
            });
        },
    },
};

Converter.rules['route6'] = {
    'add': (conv, tokens) => {
        // route6 add {<dst_IPv6address>/<prefixlen>|default}
        //     {<gateway_IPv6address>|<interface>|discard}
        //     [distance <distance>]
        //     [keepalive {on|off} [target <IPv6address>] [send-interval <interval>]
        //         [timeout <timeout>] [down-count <count>] [up-count <count>]
        // route6 add default router-advertisement interface <lan>
        //     [distance { <distance> | system-default }]
        const k1 = conv.get_index('route.ipv6');
        conv.add(`${k1}.destination`, tokens[2]);
        conv.add(`${k1}.gateway`, tokens[3]);
        if (tokens[3] == 'router-advertisement') {
            conv.add(`${k1}.router-advertisement-interface`, conv.ifmap(tokens[5]));
            idx = 5;
        } else {
            idx = 3;
        }
        const params = conv.read_params(null, tokens, idx, {
            'distance': `${k1}.distance`,
            'keepalive': {
                key: `${k1}.keepalive.service`,
                fun: on2enable,
            },
            'target': `${k1}.keepalive.target`,
            'send-interval': `${k1}.keepalive.send-interval`,
            'timeout': `${k1}.keepalive.timeout`,
            'down-count': `${k1}.keepalive.down-count`,
            'up-count': `${k1}.keepalive.up-count`,
        });
    },

    'dynamic': {
        // https://www.seil.jp/doc/index.html#fn/route/cmd/route6_dynamic_redistribute.html
        'redistribute': {
            'connected-to-ripng': {
                'disable': [],
                'enable': (conv, tokens) => {
                    if (! conv.get_memo('ripng.enable')) {
                        return;
                    }
                    conv.notsupported('ripng');
                },
            },
            'static-to-ripng': {
                'disable': [],
            },
        },

        'route-filter': {

        },

        'ripng': {
            'disable': [],
            '*': 'notsupported',
        },

        'ospf': {
            'disable': [],
            '*': 'notsupported',
        },

        'pim-sparse': {
            'disable': [],
            '*': 'notsupported',
        },
    },
};

Converter.rules['rtadvd'] = {
    'disable': 'router-advertisement.service: disable',
    'enable': 'router-advertisement.service: enable',
    'interface': {
        '*': {
            'advertise': {
                'add': (conv, tokens) => {
                    const ifname = conv.ifmap(tokens[2]);
                    const k1 = conv.get_memo(`rtadvd.interface.${ifname}`);
                    if (k1 == null) {
                        return;
                    }
                    const k2 = conv.get_index(`${k1}.advertise`);
                    // rtadvd interface { <lan> | <vlan> } advertise
                    //     add { interface-prefix | <prefix>[/<prefixlen>] }
                    //     [valid-lifetime { infinity | <lifetime> }]
                    //     [fixed-valid-lifetime { on | off }]
                    //     [preferred-lifetime { infinity | <lifetime> }]
                    //     [fixed-preferred-lifetime { on | off }]
                    //     [autonomous-flag { on | off }] [onlink-flag { on | off }]
                    const params = conv.read_params(null, tokens, 2, {
                        'advertise': false,  // skip
                        'add': {
                            key: `${k2}.prefix`,
                            fun: val => {
                                if (val == 'interface-prefix') {
                                    return 'auto';
                                } else {
                                    return val;
                                }
                            }
                        },
                        'valid-lifetime': `${k2}.valid-lifetime`,
                        'fixed-valid-lifetime': 'deprecated',
                        'preferred-lifetime': `${k2}.preferred-lifetime`,
                        'fixed-preferred-lifetime': 'deprecated',
                        'autonomous-flag': {
                            key: `${k2}.autonomous-flag`,
                            fun: on2enable
                        },
                        'onlink-flag': {
                            key: `${k2}.onlink-flag`,
                            fun: on2enable
                        },
                    });
                },
                'auto': [],
                'manual': (conv, tokens) => {
                    const ifname = ifmap(tokens[3]);
                    conv.set_memo(`rtadvd.interface.${ifname}`, conv.get_index('router-advertisement'));
                },
            },

            'dns': (conv, tokens) => {
                // rtadvd interface {<lan>|<vlan>} dns add <IPaddress>
                //     [lifetime { <lifetime> | infinity | system-default }]
                const ifname = conv.ifmap(tokens[2]);
                const k1 = conv.get_memo(`rtadvd.interface.${ifname}`);
                if (k1 == null) {
                    return;
                }
                const k2 = conv.get_index(`${k1}.dns`);
                conv.add(`${k2}.address`, tokens[5]);
                if (tokens[6] == 'lifetime') {
                    conv.add(`${k2}.lifetime`, tokens[7]);
                }
            },

            'disable': (conv, tokens) => {
                const ifname = ifmap(tokens[2]);
                conv.set_memo(`rtadvd.interface.${ifname}`, null);
            },

            'domain': (conv, tokens) => {
                // rtadvd interface {<lan>|<vlan>} domain add <domain>
                //     [lifetime { <lifetime> | infinity | system-default }]
                const ifname = conv.ifmap(tokens[2]);
                const k1 = conv.get_memo(`rtadvd.interface.${ifname}`);
                if (k1 == null) {
                    return;
                }
                const k2 = conv.get_index(`${k1}.domain`);
                conv.add(`${k2}.name`, tokens[5]);
                if (tokens[6] == 'lifetime') {
                    conv.add(`${k2}.lifetime`, tokens[7]);
                }
            },

            'enable': (conv, tokens) => {
                const ifname = ifmap(tokens[2]);
                conv.set_memo(`rtadvd.interface.${ifname}`, conv.get_index('router-advertisement'));
            },

            '*': (conv, tokens) => {
                // rtadvd interface { <lan> | <vlan> } ...
                const ifname = conv.ifmap(tokens[2]);
                const k1 = conv.get_memo(`rtadvd.interface.${ifname}`);
                if (k1 == null) {
                    return;
                }
                conv.read_params(null, tokens, 1, {
                    'curhoplimit': `${k1}.curhoplimit`,
                    'managed-flag': {
                        key: `${k1}.managed-flag`,
                        fun: on2enable
                    },
                    'max-interval': `${k1}.max-interval`,
                    'min-interval': `${k1}.min-interval`,
                    'mtu': `${k1}.mtu`,
                    'other-flag': {
                         key: `${k1}.other-flag`,
                         fun: on2enable
                    },
                    'reachable-time': `${k1}.reachable-time`,
                    'retrans-timer': `${k1}.retrans-timer`,
                    'router-lifetime': `${k1}.router-lifetime`,
                });
            }
        },
    }
};

Converter.rules['snmp'] = {
    // https://www.seil.jp/doc/index.html#fn/snmp/cmd/snmp.html
    'disable': 'snmp.service: disable',

    // snmp community <community>
    'community': tokens => `snmp.community: ${tokens[2]}`,

    'contact': tokens => `snmp.contact: ${tokens[2]}`,

    'enable': 'snmp.service: enable',

    'location': tokens => `snmp.location: ${tokens[2]}`,

    'security-model': {
        // snmp security-model community-based { on | off }
        'community-based': tokens => `snmp.security-model.community-based: ${on2enable(tokens[3])}`,

        // snmp security-model user-based { on | off }
        'user-based': tokens => `snmp.security-model.user-based: ${on2enable(tokens[3])}`,
    },

    'sysname': tokens => `snmp.sysname: ${tokens[2]}`,

    // https://www.seil.jp/doc/index.html#fn/snmp/cmd/snmp_trap.html
    'trap': {
        'add': (conv, tokens) => {
            // snmp trap add <IPaddress>
            const k1 = conv.get_index('snmp.trap.host');
            conv.add(`${k1}.address`, tokens[3]);
        },
        'disable': 'snmp.trap.service: disable',
        'enable': 'snmp.trap.service: enable',
        'watch': 'notsupported',
    },
};

Converter.rules['ssh-config'] = {
    '*': 'notsupported',
}

Converter.rules['sshd'] = {
    // https://www.seil.jp/doc/index.html#fn/ssh/cmd/sshd.html
    // https://www.seil.jp/sx4/doc/sa/shell/config/sshd.html

    'access': 'notsupported',

    'authorized-key': {
        'admin': (conv, tokens) => {
            // sshd authorized-key <user> add <name> { ssh-rsa | ssh-dss } <public_key>
            const k1 = conv.get_index('sshd.authorized-keys');
            const txt = `${tokens[5]} ${tokens[6]}`;
            conv.add(`${k1}.pubkey`, txt);
        },
        '*': 'notsupported',
    },

    // sshd { enable | disable }
    'disable': 'sshd.service: disable',

    'enable': (conv, tokens) => {
        // Note: "sshd password-authentication on" (if any) is followed by "sshd enable".
        if (! conv.get_memo('sshd.password-authetication')) {
            conv.add('sshd.password-authentication', 'enable');
        }
        conv.add('sshd.service', 'enable');
    },

    // sshd hostkey { rsa1 | rsa | dsa } { <hostkey> | auto | none }
    'hostkey': tokens => {
        if (tokens[3] == 'auto' || tokens[3] == 'none') {
            return [];
        } else {
            return 'notsupported';
        }
    },

    'password-authentication': (conv, tokens) => {
        // sshd password-authentication { on | off | system-default }
        conv.set_memo('sshd.password-authentication', tokens[2]);
        conv.add('sshd.password-authentication', on2enable(tokens[2]));
    },
};

Converter.rules['syslog'] = {
    'add': (conv, tokens) => {
        // syslog add <IPaddress>
        const k1 = conv.get_index('syslog.remote.server', true);
        conv.add(`${k1}.ipv4.address`, tokens[2]);
        if (conv.get_memo('syslog.facility')) {
            conv.add(`${k1}.facility`, conv.get_memo('syslog.facility'));
        }
        if (conv.get_memo('syslog.sequence-number')) {
            conv.add(`${k1}.sequence-number`, on2enable(conv.get_memo('syslog.sequence-number')));
        }
        if (conv.get_memo('syslog.alternate-timestamp')) {
            conv.add(`${k1}.alternate-timestamp`, on2enable(conv.get_memo('syslog.alternate-timestamp')));
        }
    },

    'alternate-timestamp': (conv, tokens) => {
        conv.set_memo('syslog.alternate-timestamp', tokens[2]);
    },

    'clear-password': 'notsupported',

    'command-log': 'notsupported',

    // syslog debug-level { on | off }
    'debug-level': (conv, tokens) => {
        // off の場合は無視して良い。
        if (tokens[2] == 'on') {
            conv.notsupported('syslog debug-level');
        }
    },

    'facility': (conv, tokens) => {
        conv.set_memo('syslog.facility', tokens[2]);
    },

    'memory-block': (conv, tokens) => {
        // syslog memory-block <function> { <blocks> | system-default }
        const k1 = conv.get_index('syslog.memory-block');
        conv.add(`${k1}.function`, tokens[2]);
        conv.add(`${k1}.size`, tokens[3]);
    },

    'remote': {
        'on': (conv, tokens) => {
            conv.set_memo('syslog.remote', 'on');
        },
        'off': [],
    },

    'remote-server': (conv, tokens) => {
        // syslog remote-server add <name> address <IPaddress>
        //     [port <port>] [hostname <hostname>] [facility <facility>]
        //     [sequence-number {on|off}] [alternate-timestamp {on|off}]
        //     [log-level <level>] [src {<IPaddress>|auto}]
        if (conv.get_memo('syslog.remote') != 'on') {
            return;
        }
        const k1 = conv.get_index('syslog.remote.server', true);
        conv.read_params(null, tokens, 3, {
            'address': `${k1}.ipv4.address`,
            'port': `${k1}.port`,
            'hostname': `${k1}.hostname`,
            'facility': `${k1}.facility`,
            'sequence-number': {
                key: `${k1}.hostname`,
                fun: on2enable
            },
            'alternate-timestamp': {
                key: `${k1}.alternate-timestamp`,
                fun: on2enable
            },
            'log-level': `${k1}.log-level`,
            'src': `${k1}.source.ipv4.address`,
        });
    },

    'sequence-number': (conv, tokens) => {
        conv.set_memo('syslog.sequence-number', tokens[2]);
    },
};

Converter.rules['telnetd'] = {
    'access': 'deprecated',

    // telnetd { enable | disable }
    'enable': 'telnetd.service: enable',
    'disable': 'telnetd.service: disable'
};

Converter.rules['timezone'] = (conv, tokens) => {
    // https://www.seil.jp/doc/index.html#fn/timezone/cmd/timezone.html
    // https://www.seil.jp/sx4/doc/sa/option/config/option.html

    // timezone <zone>
    const seiltz = unquote(tokens[1]);
    var tz = ""
    if (seiltz == "Japan") {
        tz = "JST";
    }
    conv.add('option.timezone', tz);
};

Converter.rules['translator'] = {
    // translator timeout は factory-config に入っているので無視しておく。
    'timeout': [],
    '*': 'notsupported',
};

Converter.rules['unicast-rpf'] = (conv, tokens) => {
    conv.notsupported()
};

Converter.rules['vendor'] = [];

Converter.rules['vrrp'] = {
    '*': (conv, tokens) => {
        // vrrp {<lan>|<vlan>} add vrid <vrid> address <IPv4address>/<prefixlen>
        //     [address <IPv4address>/<prefixlen>] [priority <priority>] [interval <interval>]
        //     [watch <group_name>] [preempt { on | off } ] [virtual-mac { on | off }] [delay <delay>]
        //     [dead-detect <times>] [alive-detect <times>] [enable | disable]
        if (tokens[tokens.length - 1] == 'disable') {
            return;
        }
        const k1 = conv.get_index('vrrp.vrouter');
        conv.add(`${k1}.version`, '2');
        conv.add(`${k1}.interface`, conv.ifmap(tokens[1]));
        conv.read_params(null, tokens, 2, {
            'vrid': `${k1}.vrid`,
            'address': `${k1}.address`,
            'priority': `${k1}.priority`,
            'interval': `${k1}.interval`,
            'watch': 'notsupported',
            'preempt': val => {
                if (val == 'on') {
                    return true;
                } else {
                    return 'notsupported';
                }
            },
            'virtual-mac': 'notsupported',
            'delay': `${k1}.delay`,
            'dead-detect': 'notsupported',
            'alive-detect': 'notsupported',
        });
    },
    'watch-group': 'notsupported',
};

Converter.rules['vrrp3'] = {
    '*': (conv, tokens) => {
        // vrrp3 add <name> interface {<lan>|<vlan>} vrid <vrid>
        //     address <IPaddress> [address2 <IPaddress>] [priority <priority>] [interval <interval>]
        //    [watch <group_name>] [preempt { on | off }] [delay <delay>] [enable | disable]
        if (tokens[tokens.length - 1] == 'disable') {
            return;
        }
        const k1 = conv.get_index('vrrp.vrouter');
        conv.add(`${k1}.version`, '3');
        const params = conv.read_params(null, tokens, 2, {
            'interface': {
                key: `${k1}.interface`,
                fun: conv.ifmap
            },
            'vrid': `${k1}.vrid`,
            'address': `${k1}.address`,
            'address2': 'notsupported',
            'priority': `${k1}.priority`,
            'interval': `${k1}.interval`,
            'watch': true,
            'preempt': val => {
                if (val == 'on') {
                    return true;
                } else {
                    return 'notsupported';
                }
            },
            'delay': `${k1}.delay`,
        });
        if (params['watch']) {
            const watch = conv.get_params('vrrp3.watch-group')[params['watch']];
            if (watch['interface']) {
                conv.add(`${k1}.watch.interface`, conv.ifmap(watch['interface']));
            }
            if (watch['keepalive']) {
                conv.add(`${k1}.watch.keepalive`, watch['keepalive']);
            }
            if (watch['alive-detect']) {
                conv.add(`${k1}.watch.alive-detect`, watch['alive-detect']);
            }
            if (watch['dead-detect']) {
                conv.add(`${k1}.watch.dead-detect`, watch['dead-detect']);
            }
            if (watch['route-up']) {
                conv.add(`${k1}.watch.route-up`, watch['route-up']);
            }
        }
    },
    'watch-group': (conv, tokens) => {
        // vrrp3 watch-group add <name>
        //     [interface {<lan>|<vlan>|<pppoe>|<ppp>|<wwan>}]
        //     [keepalive <IPaddress>] [alive-detect <num>] [dead-detect <num>]
        //     [route-up <IPaddress>/<prefixlen>] [route-down <IPaddress>/<prefixlen>]
        conv.read_params('vrrp3.watch-group', tokens, 3, {
            'interface': true,
            'keepalive': true,
            'alive-detect': true,
            'dead-detect': true,
            'route-up': true,
            'route-down': 'deprecated',
        });
    },
};

Converter.rules['wol-target'] = {
    '*': 'notsupported',
};

exports.Converter = Converter;