import {splitTop} from './dmm.mjs';

function expandCall(name,args,macros,depth=0){
  const macro=macros.get(name);if(!macro||depth>12||args.length!==macro.parameters.length)return null;
  const values=new Map(macro.parameters.map((parameter,index)=>[parameter,args[index]]));
  let body=macro.body.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\w+\b/g,token=>values.get(token)??token).replaceAll('##','');
  let output='',cursor=0;
  const tokens=/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(\w+)\(/g;let match;
  while((match=tokens.exec(body))){
    if(!match[1]||!macros.has(match[1]))continue;
    let end=tokens.lastIndex,balance=1,quote='',escaped=false;
    for(;end<body.length&&balance;end++){const char=body[end];if(quote){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='(')balance++;else if(char===')')balance--;}
    if(balance)continue;const replacement=expandCall(match[1],splitTop(body.slice(tokens.lastIndex,end-1)),macros,depth+1);if(replacement===null)continue;
    output+=body.slice(cursor,match.index)+replacement;cursor=end;tokens.lastIndex=end;if(output.length>2000000)return null;
  }
  return output+body.slice(cursor);
}

// Read declarative subtype helpers, not DM procedures. The upstream uses these
// for floor markings, wall mounts and many other families of mapped objects.
export function expandTypeMacros(text,macros=new Map()){
  return text.replace(/\\\r?\n/g,'').split(/\r?\n/).map(line=>{
    const define=line.match(/^\s*#define\s+(\w+)\(([^)]*)\)\s*(.*)$/);
    if(define){
      const [,name,parameters,body]=define;
      macros.delete(name);
      macros.set(name,{parameters:splitTop(parameters),body});
      return ''; // A macro body is never an assignment on the preceding type.
    }
    const undef=line.match(/^\s*#undef\s+(\w+)/);if(undef){macros.delete(undef[1]);return '';}
    const call=line.match(/^(\w+)\((.*)\)\s*;?\s*$/),macro=call&&macros.get(call[1]);
    if(!macro)return line;
    const args=splitTop(call[2]);if(args.length!==macro.parameters.length)return line;
    const body=expandCall(call[1],args,macros);if(body===null)return line;
    const blocks=[...body.matchAll(/(\/[\w/]+)\s*\{([^{}]*)\}/g)];
    if(!blocks.length||body.replace(/(\/[\w/]+)\s*\{([^{}]*)\}/g,'').trim())return line;
    const declarations=[];
    for(const [,type,assignments]of blocks){
      const properties=splitTop(assignments,';');
      if(properties.some(property=>!/^\s*(?:var\/(?:\w+\/)*)?\w+\s*=/.test(property)))return line;
      declarations.push(type,...properties.map(property=>'    '+property.trim()));
    }
    return declarations.join('\n')+'\n';
  }).join('\n');
}
