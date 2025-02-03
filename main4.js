"use strict";
const vs = `#version 300 es
in vec4 a_position;

in vec3 a_normal;
in vec3 a_tangent;
in vec2 a_texcoord;
in vec4 a_color;

uniform mat4 u_projection;
uniform mat4 u_view;
uniform mat4 u_world;
uniform vec3 u_viewWorldPosition;

out vec3 v_normal;
out vec3 v_tangent;
out vec3 v_surfaceToView;
out vec2 v_texcoord;
out vec4 v_color;

void main() {
  vec4 worldPosition = u_world * a_position;
  gl_Position = u_projection * u_view * worldPosition;
  v_surfaceToView = u_viewWorldPosition - worldPosition.xyz;

  mat3 normalMat = mat3(u_world);
  v_normal = normalize(normalMat * a_normal);
  v_tangent = normalize(normalMat * a_tangent);

  v_texcoord = a_texcoord;
  v_color = a_color;
}
`;

const fs = `#version 300 es
precision highp float;

in vec3 v_normal;
in vec3 v_tangent;
in vec3 v_surfaceToView;
in vec2 v_texcoord;
in vec4 v_color;

uniform vec3 diffuse;
uniform sampler2D diffuseMap;
uniform vec3 ambient;
uniform vec3 emissive;
uniform vec3 specular;
uniform sampler2D specularMap;
uniform float shininess;
uniform sampler2D normalMap;
uniform float opacity;
uniform vec3 u_lightDirection;
uniform vec3 u_ambientLight;

out vec4 outColor;

void main () {
  vec3 normal = normalize(v_normal) * ( float( gl_FrontFacing ) * 2.0 - 1.0 );
  vec3 tangent = normalize(v_tangent) * ( float( gl_FrontFacing ) * 2.0 - 1.0 );
  vec3 bitangent = normalize(cross(normal, tangent));

  mat3 tbn = mat3(tangent, bitangent, normal);
  normal = texture(normalMap, v_texcoord).rgb * 2. - 1.;
  normal = normalize(tbn * normal);

  vec3 surfaceToViewDirection = normalize(v_surfaceToView);
  vec3 halfVector = normalize(u_lightDirection + surfaceToViewDirection);

  float fakeLight = dot(u_lightDirection, normal) * .5 + .5;
  float specularLight = clamp(dot(normal, halfVector), 0.0, 1.0);
  vec4 specularMapColor = texture(specularMap, v_texcoord);
  vec3 effectiveSpecular = specular * specularMapColor.rgb;

  vec4 diffuseMapColor = texture(diffuseMap, v_texcoord);
  vec3 effectiveDiffuse = diffuse * diffuseMapColor.rgb * v_color.rgb;
  float effectiveOpacity = opacity * diffuseMapColor.a * v_color.a;

  outColor = vec4(
      emissive +
      ambient * u_ambientLight +
      effectiveDiffuse * fakeLight +
      effectiveSpecular * pow(specularLight, shininess),
      effectiveOpacity);
}
`;

function parseOBJ(text) {
  // because indices are base 1 let's just fill in the 0th data
  const objPositions = [[0, 0, 0]];
  const objTexcoords = [[0, 0]];
  const objNormals = [[0, 0, 0]];
  const objColors = [[0, 0, 0]];

  // same order as `f` indices
  const objVertexData = [
    objPositions,
    objTexcoords,
    objNormals,
    objColors,
  ];

  // same order as `f` indices
  let webglVertexData = [
    [],   // positions
    [],   // texcoords
    [],   // normals
    [],   // colors
  ];

  const materialLibs = [];
  const geometries = [];
  let geometry;
  let groups = ['default'];
  let material = 'default';
  let object = 'default';

  const noop = () => { };

  function newGeometry() {
    // If there is an existing geometry and it's
    // not empty then start a new one.
    if (geometry && geometry.data.position.length) {
      geometry = undefined;
    }
  }

  function setGeometry() {
    if (!geometry) {
      const position = [];
      const texcoord = [];
      const normal = [];
      const color = [];
      webglVertexData = [
        position,
        texcoord,
        normal,
        color,
      ];
      geometry = {
        object,
        groups,
        material,
        data: {
          position,
          texcoord,
          normal,
          color,
        },
      };
      geometries.push(geometry);
    }
  }

  function addVertex(vert) {
    const ptn = vert.split('/');
    ptn.forEach((objIndexStr, i) => {
      if (!objIndexStr) {
        return;
      }
      const objIndex = parseInt(objIndexStr);
      const index = objIndex + (objIndex >= 0 ? 0 : objVertexData[i].length);
      webglVertexData[i].push(...objVertexData[i][index]);
      // if this is the position index (index 0) and we parsed
      // vertex colors then copy the vertex colors to the webgl vertex color data
      if (i === 0 && objColors.length > 1) {
        geometry.data.color.push(...objColors[index]);
      }
    });
  }

  const keywords = {
    v(parts) {
      // if there are more than 3 values here they are vertex colors
      if (parts.length > 3) {
        objPositions.push(parts.slice(0, 3).map(parseFloat));
        objColors.push(parts.slice(3).map(parseFloat));
      } else {
        objPositions.push(parts.map(parseFloat));
      }
    },
    vn(parts) {
      objNormals.push(parts.map(parseFloat));
    },
    vt(parts) {
      // should check for missing v and extra w?
      objTexcoords.push(parts.map(parseFloat));
    },
    f(parts) {
      setGeometry();
      const numTriangles = parts.length - 2;
      for (let tri = 0; tri < numTriangles; ++tri) {
        addVertex(parts[0]);
        addVertex(parts[tri + 1]);
        addVertex(parts[tri + 2]);
      }
    },
    s: noop,    // smoothing group
    mtllib(parts) {
      // the spec says there can be multiple file here
      // but I found one with a space in the filename
      materialLibs.push(parts.join(' '));
    },
    usemtl(parts, unparsedArgs) {
      material = unparsedArgs;
      newGeometry();
    },
    g(parts) {
      groups = parts;
      newGeometry();
    },
    o(parts, unparsedArgs) {
      object = unparsedArgs;
      newGeometry();
    },
  };

  const keywordRE = /(\w*)(?: )*(.*)/;
  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; ++lineNo) {
    const line = lines[lineNo].trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const m = keywordRE.exec(line);
    if (!m) {
      continue;
    }
    const [, keyword, unparsedArgs] = m;
    const parts = line.split(/\s+/).slice(1);
    const handler = keywords[keyword];
    if (!handler) {
      console.warn('unhandled keyword:', keyword);  // eslint-disable-line no-console
      continue;
    }
    handler(parts, unparsedArgs);
  }

  // remove any arrays that have no entries.
  for (const geometry of geometries) {
    geometry.data = Object.fromEntries(
      Object.entries(geometry.data).filter(([, array]) => array.length > 0));
  }

  return {
    geometries,
    materialLibs,
  };
}

function parseMapArgs(unparsedArgs) {
  // TODO: handle options
  return unparsedArgs;
}

function parseMTL(text) {
  const materials = {};
  let material;

  const keywords = {
    newmtl(parts, unparsedArgs) {
      material = {};
      materials[unparsedArgs] = material;
    },
    /* eslint brace-style:0 */
    Ns(parts) { material.shininess = parseFloat(parts[0]); },
    Ka(parts) { material.ambient = parts.map(parseFloat); },
    Kd(parts) { material.diffuse = parts.map(parseFloat); },
    Ks(parts) { material.specular = parts.map(parseFloat); },
    Ke(parts) { material.emissive = parts.map(parseFloat); },
    map_Kd(parts, unparsedArgs) { material.diffuseMap = parseMapArgs(unparsedArgs); },
    map_Ns(parts, unparsedArgs) { material.specularMap = parseMapArgs(unparsedArgs); },
    map_Bump(parts, unparsedArgs) { material.normalMap = parseMapArgs(unparsedArgs); },
    map_d(parts, unparsedArgs) { material.opacityMap = parseMapArgs(unparsedArgs); },
    Ni(parts) { material.opticalDensity = parseFloat(parts[0]); },
    d(parts) { material.opacity = parseFloat(parts[0]); },
    illum(parts) { material.illum = parseInt(parts[0]); },
  };


  const keywordRE = /(\w*)(?: )*(.*)/;
  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; ++lineNo) {
    const line = lines[lineNo].trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const m = keywordRE.exec(line);
    if (!m) {
      continue;
    }
    const [, keyword, unparsedArgs] = m;
    const parts = line.split(/\s+/).slice(1);
    const handler = keywords[keyword];
    if (!handler) {
      console.warn('unhandled keyword:', keyword);  // eslint-disable-line no-console
      continue;
    }
    handler(parts, unparsedArgs);
  }

  return materials;
}
function makeIndexIterator(indices) {
  let ndx = 0;
  const fn = () => indices[ndx++];
  fn.reset = () => { ndx = 0; };
  fn.numElements = indices.length;
  return fn;
}

function makeUnindexedIterator(positions) {
  let ndx = 0;
  const fn = () => ndx++;
  fn.reset = () => { ndx = 0; };
  fn.numElements = positions.length / 3;
  return fn;
}
const subtractVector2 = (a, b) => a.map((v, ndx) => v - b[ndx]);

function generateTangents(position, texcoord, indices) {
  const getNextIndex = indices ? makeIndexIterator(indices) : makeUnindexedIterator(position);
  const numFaceVerts = getNextIndex.numElements;
  const numFaces = numFaceVerts / 3;

  const tangents = [];
  for (let i = 0; i < numFaces; ++i) {
    const n1 = getNextIndex();
    const n2 = getNextIndex();
    const n3 = getNextIndex();

    const p1 = position.slice(n1 * 3, n1 * 3 + 3);
    const p2 = position.slice(n2 * 3, n2 * 3 + 3);
    const p3 = position.slice(n3 * 3, n3 * 3 + 3);

    const uv1 = texcoord.slice(n1 * 2, n1 * 2 + 2);
    const uv2 = texcoord.slice(n2 * 2, n2 * 2 + 2);
    const uv3 = texcoord.slice(n3 * 2, n3 * 2 + 2);

    const dp12 = m4.subtractVectors(p2, p1);
    const dp13 = m4.subtractVectors(p3, p1);

    const duv12 = subtractVector2(uv2, uv1);
    const duv13 = subtractVector2(uv3, uv1);


    const f = 1.0 / (duv12[0] * duv13[1] - duv13[0] * duv12[1]);
    const tangent = Number.isFinite(f)
      ? m4.normalize(m4.scaleVector(m4.subtractVectors(
        m4.scaleVector(dp12, duv13[1]),
        m4.scaleVector(dp13, duv12[1]),
      ), f))
      : [1, 0, 0];

    tangents.push(...tangent, ...tangent, ...tangent);
  }

  return tangents;
}


// Função para criar objetos e carregar texturas
async function createObjects(gl, meshProgramInfo, object) {
  const objHref = `pack2/OBJ/${object}.obj`;
  const response = await fetch(objHref);
  const text = await response.text();
  const obj = parseOBJ(text);
  
  const matHref = `pack2/OBJ/${object}.mtl`;
  const matResponse = await fetch(matHref);
  const matText = await matResponse.text();
  const materials = parseMTL(matText);

  const textures = {
    defaultWhite: twgl.createTexture(gl, {src: [255, 255, 255, 255]}),
    defaultNormal: twgl.createTexture(gl, {src: [127, 127, 255, 0]}),
  };

  // Carregar texturas para os materiais
  for (const material of Object.values(materials)) {
    Object.entries(material)
      .filter(([key]) => key.endsWith('Map'))
      .forEach(([key, filename]) => {
        let texture = textures[filename];
        if (!texture) {
          const textureHref = new URL(filename, "http://0.0.0.0:8000/").href;
          texture = twgl.createTexture(gl, {src: textureHref, flipY: true});
          textures[filename] = texture;
        }
        material[key] = texture;
      });
  }

  // Ajustar materiais para visualização do mapa especular
  Object.values(materials).forEach(m => {
    m.shininess = 25;
    m.specular = [3, 2, 1];
  });

  const defaultMaterial = {
    diffuse: [1, 1, 1],
    diffuseMap: textures.defaultWhite,
    normalMap: textures.defaultNormal,
    ambient: [0, 0, 0],
    specular: [1, 1, 1],
    specularMap: textures.defaultWhite,
    shininess: 400,
    opacity: 1,
  };

  const parts = obj.geometries.map(({material, data}) => {
    if (data.color) {
      if (data.position.length === data.color.length) {
        data.color = { numComponents: 3, data: data.color };
      }
    } else {
      data.color = { value: [1, 1, 1, 1] };
    }

    if (data.texcoord && data.normal) {
      data.tangent = generateTangents(data.position, data.texcoord);
    } else {
      data.tangent = { value: [1, 0, 0] };
    }

    if (!data.texcoord) {
      data.texcoord = { value: [0, 0] };
    }

    if (!data.normal) {
      data.normal = { value: [0, 0, 1] };
    }

    const bufferInfo = twgl.createBufferInfoFromArrays(gl, data);
    const vao = twgl.createVAOFromBufferInfo(gl, meshProgramInfo, bufferInfo);
    return {
      material: {
        ...defaultMaterial,
        ...materials[material],
      },
      bufferInfo,
      vao,
    };
  });

  return parts ;
}

function exportToJson(objects, filename = "data.json") {
    // Filtra apenas os campos necessários de cada objeto
    const filteredObjects = objects.map(({ obj, offsets, u_matrix, rotate, scale, texture }) => ({
        obj,
        offsets,
        u_matrix,
        rotate,
        scale,
        texture,
    }));

    const jsonData = JSON.stringify(filteredObjects, null, 2); // Converte para JSON formatado
    const blob = new Blob([jsonData], { type: "application/json" });
    const link = document.createElement("a");

    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function importFromJson(file, objects, objectsParts, objectsTextureSource) {
  const reader = new FileReader();

  reader.onload = function (event) {
      try {
          const data = JSON.parse(event.target.result); // Converte JSON para objeto
          if (Array.isArray(data)) {
              data.forEach(item => {
                  if (item.obj && item.offsets && item.rotate && item.scale !== undefined) {
                      objects.push({
                          obj: item.obj,
                          parts: objectsParts[item.obj],
                          offsets: item.offsets,
                          u_matrix: m4.translate(m4.identity(), item.u_matrix[12], item.u_matrix[13], item.u_matrix[14]),
                          rotate: item.rotate,
                          scale: item.scale,
                          texture: objectsTextureSource[item.obj].textu1,
                      });
                  }
              });
              console.log("Importação concluída:", objects);
          } else {
              console.error("O arquivo JSON não contém um array válido.");
          }

      } catch (error) {
          console.error("Erro ao processar o arquivo JSON:", error);
      }
  };

  reader.readAsText(file);
}
async function drawCanvaBtn(btn, object){
  const gl = btn.getContext("webgl2");
  if (!gl) {
    return;
  } 
  const meshProgramInfo = twgl.createProgramInfo(gl, [vs, fs]);
  twgl.setAttributePrefix("a_");

  const parts = await createObjects(gl, meshProgramInfo, object);

  function renderBtn(time) {
    time *= 0.001;  // convert to seconds

    twgl.resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    let projection = m4.perspective(1.5, gl.canvas.clientWidth / gl.canvas.clientHeight, 0.001, 10);
    let cameraPosition = []
    let camera = [];

    if(object == "DeadTree_2"){
      cameraPosition = [0, 2.0, 5.0];
      camera = m4.lookAt(cameraPosition, [0,2.5,0], [0, 1, 0]);
    }else{
      cameraPosition = [0, .5, .8];
      camera = m4.lookAt(cameraPosition, [0,0,0], [0, 1, 0]);
    }
    const view = m4.inverse(camera);
    const sharedUniforms = {
      u_lightDirection: m4.normalize([-1, 3, 5]),
      u_view: view,
      u_projection: projection,
      u_viewWorldPosition: cameraPosition,
    };

    gl.useProgram(meshProgramInfo.program);

    // calls gl.uniform
    twgl.setUniforms(meshProgramInfo, sharedUniforms);

    // compute the world matrix once since all parts
    // are at the same space.
    let u_world = m4.yRotation(time);
    u_world = m4.translate(u_world, 0.10415348410606384, -0.5595740079879761, 0.01761901192367077 );

    for (const {bufferInfo, vao, material} of parts) {
      // set the attributes for this part.
      gl.bindVertexArray(vao);
      // calls gl.uniform
      twgl.setUniforms(meshProgramInfo, {
        u_world,
      }, material);
      // calls gl.drawArrays or gl.drawElements
      twgl.drawBufferInfo(gl, bufferInfo);
    }

    requestAnimationFrame(renderBtn);
  }
  requestAnimationFrame(renderBtn);

};

function insertIntoDiv(objects, editObj) {
  const container = document.getElementById("obj_list_cont");
  let num = 0;
  container.innerHTML = "";

  // Cria a lista
  const ul = document.createElement("ul");

  objects.forEach(object => {
      const li = document.createElement("li");
      if (num == editObj){ li.style.backgroundColor = "red";}
      li.textContent = object.obj+(`_${num}`);
      ul.appendChild(li);
      num++
  });

  // Adiciona a lista na div
  container.appendChild(ul);
}

async function main() {
  const canvas = document.querySelector("#canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    return;
  }

  twgl.setAttributePrefix("a_");

  const meshProgramInfo = twgl.createProgramInfo(gl, [vs, fs]);
  
  const btn0 = document.getElementById("op0");
  const btn1 = document.getElementById("op1");
  const btn2 = document.getElementById("op2");
  const btn3 = document.getElementById("op3");
  const btn4 = document.getElementById("op4");

  drawCanvaBtn(btn0, "DeadTree_2");
  drawCanvaBtn(btn1, "Clover_2");
  drawCanvaBtn(btn2, "Plant_1");
  drawCanvaBtn(btn3, "RockPath_Round_Wide");
  drawCanvaBtn(btn4, "Petal_5");
  
  // Obter valores dos controles
  const translateX = document.getElementById('translateX');
  const translateY = document.getElementById('translateY');
  const translateZ = document.getElementById('translateZ');
  const rotateX = document.getElementById('rotateX');
  const rotateY = document.getElementById('rotateY');
  const rotateZ = document.getElementById('rotateZ');
  const scaleX = document.getElementById('scaleX');

  let editObj = 0;
  function objectToSlider(object){
    scaleX.value = objects[editObj].scale; 
    translateX.value = objects[editObj].u_matrix[12];
    translateY.value = objects[editObj].u_matrix[13];
    translateZ.value = objects[editObj].u_matrix[14];
    rotateX.value = objects[editObj].rotate[0];
    rotateY.value = objects[editObj].rotate[1];
    rotateZ.value = objects[editObj].rotate[2];
  };
  window.addEventListener("keydown", function(e){
    if(e.key == "a"){
      if (editObj < objects.length - 1) {editObj++;}
      else {editObj = objects.length - 1;};
      objectToSlider(objects[editObj]);
      insertIntoDiv(objects, editObj);
    }
    if(e.key == "z"){
      if (editObj > 0) {editObj--;}
      else {editObj = 0;}
      objectToSlider(objects[editObj]);
      insertIntoDiv(objects, editObj);
    }
    if(e.key == "s"){
      exportToJson(objects);
    }

  });
  const delObj = document.getElementById("del");
  const chg_textu = document.getElementById("chg_textu");
  

  const objectsParts = {
    "DeadTree_2" : await createObjects(gl, meshProgramInfo, "DeadTree_2"),
    "Clover_2" : await createObjects(gl, meshProgramInfo, "Clover_2"),
    "Plant_1" : await createObjects(gl, meshProgramInfo, "Plant_1"),  
    "RockPath_Round_Wide" : await createObjects(gl, meshProgramInfo, "RockPath_Round_Wide"),  
    "Petal_5" : await createObjects(gl, meshProgramInfo, "Petal_5"),  
  };
  //objectsParts["DeadTree_2"][0].material.diffuseMap = twgl.createTexture(gl, {src: "pack2/Textures/DeadTree_2/Bark_DeadTree_Normal.png"});
  const objectsTextureSource ={
    "DeadTree_2" : {textu1: twgl.createTexture(gl, {src:"pack2/Textures/Bark_DeadTree.png"}), textu2: twgl.createTexture(gl, {src:"pack2/Textures/Bark_DeadTree_Normal.png"})},
    "Clover_2" : {textu1: twgl.createTexture(gl, {src:"pack2/Textures/Leaves.png"}), textu2: twgl.createTexture(gl, {src:"pack2/Textures/Leaves_Normal.png"})},
    "Plant_1" : {textu1: twgl.createTexture(gl, {src:"pack2/Textures/Leaves.png"}), textu2: twgl.createTexture(gl, {src:"pack2/Textures/Leaves_Normal.png"})},
    "RockPath_Round_Wide" : {textu1: twgl.createTexture(gl, {src:"pack2/Textures/PathRocks_Diffuse.png"}), textu2: twgl.createTexture(gl, {src:"pack2/Textures/PathRocks_Diffuse_Normal.png"})},
    "Petal_5" : {textu1: twgl.createTexture(gl, {src:"pack2/Textures/Flowers.png"}), textu2: twgl.createTexture(gl, {src:"pack2/Textures/Flowers_Normal.png"})},
  }

  let objects = [];

  chg_textu.addEventListener("click", function(){
    if(objects[editObj].texture == objectsTextureSource[objects[editObj].obj].textu1){
      objects[editObj].texture = objectsTextureSource[objects[editObj].obj].textu2;
    }else{
      objects[editObj].texture = objectsTextureSource[objects[editObj].obj].textu1;
    }
  });
  delObj.addEventListener("click", function(){
    objects.splice(editObj, 1);
    editObj = 0;
    insertIntoDiv(objects, editObj);
  });

  document.getElementById("jsonInput").addEventListener("change", function (event) {
    const file = event.target.files[0];
    if (file) {
        importFromJson(file, objects, objectsParts, objectsTextureSource);
    }
    for(let i = 0 ; i < objects.length; i++){
      editObj = i;
    }
  });

  btn0.addEventListener("click", function(){
    const newObject ={
      obj: "DeadTree_2",
      parts: objectsParts["DeadTree_2"],
      offsets: [0,0,0],
      u_matrix: m4.identity(),
      rotate: [0, 0, 0],
      scale: 1,
      texture: objectsTextureSource["DeadTree_2"].textu1
    }
    objects.push(newObject);
    insertIntoDiv(objects, editObj);
    
  });
  btn1.addEventListener("click", function(){
    const newObject = {
      obj: "Clover_2",
      parts: objectsParts["Clover_2"],
      offsets: [0,0,0],
      u_matrix: m4.identity(),
      rotate: [0, 0, 0],
      scale: 1,
      texture: objectsTextureSource["Clover_2"].textu1
    }
  
    objects.push(newObject);
    insertIntoDiv(objects, editObj);
  });
  btn2.addEventListener("click", function(){
    const newObject ={
      obj: "Plant_1",
      parts: objectsParts["Plant_1"],
      offsets: [0,0,0],
      u_matrix: m4.identity(),
      rotate: [0, 0, 0],
      scale: 1,
      texture: objectsTextureSource["Plant_1"].textu1
      }
    
    objects.push(newObject);
    insertIntoDiv(objects, editObj);
  });
  btn3.addEventListener("click", function(){
     const newObject = {
      obj: "RockPath_Round_Wide",
      parts: objectsParts["RockPath_Round_Wide"],
      offsets: [0,0,0],
      u_matrix: m4.identity(),
      rotate: [0, 0, 0],
      scale: 1,
      texture: objectsTextureSource["RockPath_Round_Wide"].textu1
    }
      objects.push(newObject);
    insertIntoDiv(objects, editObj);
  });
  btn4.addEventListener("click", function(){
    const newObject = {
      obj: "Petal_5",
      parts: objectsParts["Petal_5"],
      offsets: [0,0,0],
      u_matrix: m4.identity(),
      rotate: [0, 0, 0],
      scale: 1,
      texture: objectsTextureSource["Petal_5"].textu1
      }
    objects.push(newObject);
    insertIntoDiv(objects, editObj);
  });


  function render(time) {
    time *= 0.001;

    twgl.resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const projection = m4.perspective(0.61, gl.canvas.clientWidth / gl.canvas.clientHeight, 0.016, 100);
    const cameraPosition = m4.addVectors([0, 0, 0], [0, 2, 1.0]);
    const camera = m4.lookAt([4, 3, -1], [0,0,0], [0, 1, 0]);
    const view = m4.inverse(camera);

    const sharedUniforms = {
      u_lightDirection: m4.normalize([-1,3,5]),
      u_view: view,
      u_projection: projection,
      u_viewWorldPosition: cameraPosition,
    };

    gl.useProgram(meshProgramInfo.program);
    twgl.setUniforms(meshProgramInfo, sharedUniforms);
    // Aplicar transformações na matriz u_world
    for(let i = 0 ; i < objects.length; i++){
      const object = objects[i];
     
      if(i == editObj){
        object.offsets[0] = parseFloat(translateX.value);
        object.offsets[1] = parseFloat(translateY.value);
        object.offsets[2] = parseFloat(translateZ.value);
        object.u_matrix = m4.identity();
        object.u_matrix = m4.translate(object.u_matrix, parseFloat(translateX.value), parseFloat(translateY.value), parseFloat(translateZ.value));
        object.u_matrix = m4.scale(object.u_matrix, parseFloat(scaleX.value), parseFloat(scaleX.value), parseFloat(scaleX.value));
        object.scale = parseFloat(scaleX.value);
        object.u_matrix = m4.xRotate(object.u_matrix, parseFloat(rotateX.value));
        object.rotate[0] = parseFloat(rotateX.value);
        object.u_matrix = m4.yRotate(object.u_matrix, parseFloat(rotateY.value));
        object.rotate[1] = parseFloat(rotateY.value);
        object.u_matrix = m4.zRotate(object.u_matrix, parseFloat(rotateZ.value));
        object.rotate[2] = parseFloat(rotateZ.value);

        object.u_matrix = m4.scale(object.u_matrix, parseFloat(scaleX.value), parseFloat(scaleX.value), parseFloat(scaleX.value));
      }
      for (const { bufferInfo, vao, material } of object.parts) {
        material.diffuseMap = object.texture;
        gl.bindVertexArray(vao);
        twgl.setUniforms(meshProgramInfo, {u_world :object.u_matrix}, material);
        twgl.drawBufferInfo(gl, bufferInfo);
      }

    }
    requestAnimationFrame(render);
    }
  requestAnimationFrame(render);
}

main();