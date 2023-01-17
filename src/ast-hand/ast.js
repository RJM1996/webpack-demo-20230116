/**
 * 将源代码转换为分词数组
 * @param {*} input 源代码字符串
 * @returns tokens
 */
function tokenizer(input) {
  let current = 0 // 记录当前访问的位置
  let tokens = [] // 最终生成的tokens
  // 循环遍历input
  while (current < input.length) {
    let curChar = input[current]
    // 匹配括号
    if (['(', ')'].includes(curChar)) {
      tokens.push({
        type: 'paren',
        value: curChar,
      })
      current++
      continue
    }

    // 匹配空格
    const WHITESPACE = /\s/
    if (WHITESPACE.test(curChar)) {
      current++
      continue
    }
    // 匹配数字,需要确保能匹配到连续的数字
    const NUMBER = /[0-9]/
    if (NUMBER.test(curChar)) {
      let numValue = ''
      while (NUMBER.test(curChar)) {
        numValue += curChar
        curChar = input[++current]
      }
      tokens.push({ type: 'number', value: numValue })
      continue
    }
    // 匹配字符串,同样需要保证匹配到连续字符串
    // 只识别双引号开头的字符串
    if (curChar === '"') {
      let strValue = ''
      curChar = input[++current]
      while (curChar !== '"') {
        strValue += curChar
        curChar = input[++current]
      }
      tokens.push({
        type: 'string',
        value: strValue,
      })
      curChar = input[++current]
      continue
    }
    // 匹配函数名等标识符
    const LETTER = /[a-z]/i
    if (LETTER.test(curChar)) {
      let letterValue = ''
      while (LETTER.test(curChar)) {
        letterValue += curChar
        curChar = input[++current]
      }
      tokens.push({ type: 'name', value: letterValue })
      continue
    }

    console.log(`I dont know what this char is: ${curChar} ${current}`)
    throw new Error(`I dont know what this char is: ${curChar}`)
  }
  return tokens
}

/**
 * 将 tokens 转换为 ast
 * @param {*} tokens
 * @returns ast
 */
function parser(tokens) {
  let current = 0 // 访问tokens的下标

  // walk函数辅助我们遍历整个tokens
  function walk() {
    let token = tokens[current]
    // 根据token类型生成对应的节点
    if (token.type === 'number') {
      current++
      return {
        type: 'NumberLiteral',
        value: token.value,
      }
    }
    if (token.type === 'string') {
      current++
      return {
        type: 'StringLiteral',
        value: token.value,
      }
    }
    // 匹配调用表达式(函数调用等)
    if (token.type === 'paren' && token.value === '(') {
      // 举例: (add 2 3)
      token = tokens[++current] // 跳过括号(
      const node = {
        type: 'CallExpression',
        value: token.value, // 即函数名add
        params: [], // 函数参数
      }
      // 获取函数参数(参数可能也是个函数调用表达式,需要递归遍历)
      token = tokens[++current]
      while (token.type !== 'paren' || (token.type === 'paren' && token.value !== ')')) {
        node.params.push(walk())
        token = tokens[current]
      }
      // 到这里说明参数读取完毕
      current++ // 跳过括号)
      return node
    }

    // 容错处理，如果没有匹配到预计的类型，就说明出现了parse无法识别的token
    throw new TypeError(`can not parse ${token.type}`)
  }
  // 现在我们创建AST，树的最根层就是Program
  let ast = {
    type: 'Program',
    body: [],
  }
  // 然后我们通过调用walk遍历tokens将tokens内的对象，转化为AST的节点，完成AST的构建
  while (current < tokens.length) {
    ast.body.push(walk())
  }
  return ast
}

/**
 * 提供访问器对ast进行遍历转换
 * @param {*} ast
 * @param {*} visitor
 */
function traverse(ast, visitor) {
  function traverseArray(array, parent) {
    array.forEach((child) => traverseNode(child, parent))
  }
  function traverseNode(node, parent) {
    // 获取访问器中处理该节点的函数
    const methods = visitor[node.type]
    if (methods && methods.enter) {
      methods.enter(node, parent)
    }
    // 处理不同的节点类型
    switch (node.type) {
      // ast 树根
      case 'Program':
        traverseArray(node.body, node)
        break
      // 调用表达式,遍历参数
      case 'CallExpression':
        traverseArray(node.params, node)
        break
      // 字符串和数字没有子节点,直接跳过
      case 'NumberLiteral':
      case 'StringLiteral':
        break
      default:
        throw new TypeError(`can not traverse type: ${node.type}`)
    }
    // 到这里该节点遍历完成,执行exit
    if (methods && methods.exit) {
      methods.exit(node, parent)
    }
  }

  traverseNode(ast, null)
}

/**
 * 将旧的ast通过traverse转换为新的ast
 * @param {*} ast
 * @returns
 */
function transformer(ast) {
  // 最终返回的新AST
  const newAst = {
    type: 'Program',
    body: [],
  }
  // 这里相当于将在旧的AST上创建一个_content,这个属性就是新AST的body，因为是引用，所以后面可以直接操作就的AST
  ast._context = newAst.body
  // 用之前创建的访问器来访问这个AST的所有节点
  traverse(ast, {
    // 处理数字类型
    NumberLiteral: {
      enter(node, parent) {
        // 创建一个新的节点，其实就是创建新AST的节点，这个新节点存在于父节点的body中
        parent._context.push({
          type: 'NumberLiteral',
          value: node.value,
        })
      },
    },

    // 处理字符串类型
    StringLiteral: {
      enter(node, parent) {
        parent._context.push({
          type: 'StringLiteral',
          value: node.value,
        })
      },
    },

    // 处理调用表达式
    CallExpression: {
      enter(node, parent) {
        // 在新的AST中如果是调用语句，type是`CallExpression`，同时他还有一个`Identifier`，来标识操作
        let expression = {
          type: 'CallExpression',
          callee: {
            type: 'Identifier',
            name: node.value,
          },
          arguments: [],
        }
        // 在原来的节点上再创建一个新的属性，用于存放参数 这样当子节点修改_context时，会同步到expression.arguments中，这里用的是同一个内存地址
        node._context = expression.arguments
        // 这里需要判断父节点是否是调用语句，如果不是，那么就使用`ExpressionStatement`将`CallExpression`包裹，因为js中顶层的`CallExpression`是有效语句
        if (parent.type !== 'CallExpression') {
          expression = {
            type: 'ExpressionStatement',
            expression: expression,
          }
        }
        parent._context.push(expression)
      },
    },
  })
  return newAst
}

/**
 * 根据新的ast生成新的代码
 * @param {*} node
 * @returns
 */
function codeGenerator(node) {
  // 我们以节点的种类拆解(语法树)
  switch (node.type) {
    // 如果是Progame,那么就是AST的最根部了，他的body中的每一项就是一个分支，我们需要将每一个分支都放入代码生成器中
    case 'Program':
      return node.body.map(codeGenerator).join('\n')
    // 如果是声明语句, 注意看新的AST结构，那么在声明语句中expression，就是声明的标示，我们以他为参数再次调用codeGenerator
    case 'ExpressionStatement':
      return codeGenerator(node.expression) + ';'
    // 如果是调用语句，我们需要打印出调用者的名字加括号，中间放置参数如生成这样"add(2,2)",
    case 'CallExpression':
      return codeGenerator(node.callee) + '(' + node.arguments.map(codeGenerator).join(', ') + ')'
    // 如果是标识符就直接返回值 如： (add 2 2),在新AST中 add就是那个identifier节点
    case 'Identifier':
      return node.name
    // 如果是数字就直接返回值
    case 'NumberLiteral':
      return node.value
    // 如果是文本就给值加个双引号
    case 'StringLiteral':
      return '"' + node.value + '"'
    // 容错处理
    default:
      throw new TypeError(node.type)
  }
}

function compiler(input) {
  const tokens = tokenizer(input)
  const ast = parser(tokens)
  const newAst = transformer(ast)
  const output = codeGenerator(newAst)
  return output
}

const code = '(add 2 (subtract 4 2))'
console.log(compiler(code))
