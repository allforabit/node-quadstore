
'use strict';

import {
  consumeInBatches,
  consumeOneByOne,
  emptyObject,
  nanoid,
  streamToArray,
  termNames,
  defaultIndexes,
  pFromCallback,
  separator,
} from './utils';
import {EventEmitter} from 'events';
import {EmptyIterator, TransformIterator} from 'asynciterator';
import {DataFactory, Quad, Quad_Graph, Quad_Object, Quad_Predicate, Quad_Subject, Store, Stream, Term} from 'rdf-js';
import {
  DefaultGraphMode,
  DelStreamOpts,
  BatchOpts,
  DelOpts,
  PutOpts,
  PatchOpts,
  GetOpts,
  InternalIndex,
  PutStreamOpts,
  Binding,
  BindingArrayResult,
  BindingStreamResult, BooleanResult,
  Pattern,
  QuadArrayResult,
  QuadStreamResult,
  StoreOpts,
  VoidResult,
  TSReadable,
  ResultType,
  SparqlOpts,
  TermName, Prefixes,
} from './types';
import {AbstractChainedBatch, AbstractLevelDOWN} from 'abstract-leveldown';
import {getApproximateSize, getStream} from './get';
import {Algebra} from 'sparqlalgebrajs';
import {sparql, sparqlStream} from './sparql';
import {DataFactory as RdfDataFactory} from 'rdf-data-factory';
import {Scope} from './scope';
import {quadWriter, copyBuffer} from './serialization';
import {ComunicaActorInitSparql} from './types/comunica';


const __value = Buffer.alloc(32);

export class Quadstore implements Store {

  readonly db: AbstractLevelDOWN;

  readonly indexes: InternalIndex[];
  readonly id: string;

  readonly comunica: ComunicaActorInitSparql;
  readonly prefixes: Prefixes;

  readonly dataFactory: DataFactory;

  sparqlMode: boolean;
  defaultGraphMode: DefaultGraphMode;

  constructor(opts: StoreOpts) {
    this.dataFactory = opts.dataFactory || new RdfDataFactory();
    this.db = opts.backend;
    this.indexes = [];
    this.id = nanoid();
    (opts.indexes || defaultIndexes)
      .forEach((index: TermName[]) => this._addIndex(index));
    this.comunica = opts.comunica;
    this.prefixes = opts.prefixes || {
      expandTerm: term => term,
      compactIri: iri => iri,
    };
    this.sparqlMode = false;
    this.defaultGraphMode = opts.defaultGraphMode || DefaultGraphMode.UNION;
  }

  fork(opts: { defaultGraphMode?: DefaultGraphMode, sparqlMode?: boolean } = {}): Quadstore {
    const fork = <Quadstore>Object.create(this);
    if (typeof opts.sparqlMode === 'boolean') {
      fork.sparqlMode = opts.sparqlMode;
    }
    if (opts.defaultGraphMode) {
      fork.defaultGraphMode = opts.defaultGraphMode;
    }
    return fork;
  }

  protected ensureReady() {
    if (this.db.status !== 'open') {
      throw new Error(`Store is not ready (status: "${this.db.status}"). Did you call store.open()?`);
    }
  }

  protected waitForStatus(status: string, timeout: number = 200) {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        clearInterval(i);
        clearTimeout(t);
        reject(new Error(`Timeout while waiting for status "${status}"`));
      }, timeout);
      const i = setInterval(() => {
        if (this.db.status === status) {
          clearInterval(i);
          clearTimeout(t);
          resolve();
        }
      }, 10);
    });
  }

  async open() {
    switch (this.db.status) {
      case 'closing':
        await this.waitForStatus('closed');
      case 'new':
      case 'closed':
        await pFromCallback((cb) => { this.db.open(cb); });
        break;
      case 'opening':
        await this.waitForStatus('open');
        break;
      case 'open':
      default:
    }
  }

  async close() {
    switch (this.db.status) {
      case 'opening':
        await this.waitForStatus('open');
      case 'open':
      case 'new':
        await pFromCallback((cb) => { this.db.close(cb); });
        break;
      case 'closing':
        await this.waitForStatus('closed');
        break;
      case 'closed':
      default:
    }
  }

  toString() {
    return this.toJSON();
  }

  toJSON() {
    return `[object ${this.constructor.name}::${this.id}]`;
  }

  _addIndex(terms: TermName[]): void {
    const name = terms.map(t => t.charAt(0).toUpperCase()).join('');
    this.indexes.push({
      terms,
      prefix: name + separator,
    });
  }

  async clear(): Promise<void> {
    if (typeof this.db.clear === 'function') {
      return new Promise((resolve, reject) => {
        this.db.clear((err: Error) => {
          err ? reject(err) : resolve();
        });
      });
    }
    await this.delStream((await this.getStream({})).iterator, { batchSize: 20 });
  }

  match(subject?: Quad_Subject, predicate?: Quad_Predicate, object?: Quad_Object, graph?: Quad_Graph, opts: GetOpts = emptyObject): Stream<Quad> {
    // This is required due to the fact that Comunica may invoke the `.match()`
    // method in generalized RDF mode, under which the subject may be a literal
    // term.
    // @ts-ignore
    if (subject && subject.termType === 'Literal') {
      return new EmptyIterator();
    }
    const pattern: Pattern = { subject, predicate, object, graph };
    return new TransformIterator<Quad, Quad>(
      this.getStream(pattern, opts).then(results => results.iterator),
    );
  }

  async countQuads(subject?: Quad_Subject, predicate?: Quad_Predicate, object?: Quad_Object, graph?: Quad_Graph, opts: GetOpts = emptyObject): Promise<number> {
    // This is required due to the fact that Comunica may invoke the `.match()`
    // method in generalized RDF mode, under which the subject may be a literal
    // term.
    // @ts-ignore
    if (subject && subject.termType === 'Literal') {
      return 0;
    }
    const pattern: Pattern = { subject, predicate, object, graph };
    const results = await this.getApproximateSize(pattern, opts);
    return results.approximateSize;
  }

  import(source: Stream<Quad>): EventEmitter {
    const emitter = new EventEmitter();
    this.putStream(<TSReadable<Quad>>source, {})
      .then(() => { emitter.emit('end'); })
      .catch((err) => { emitter.emit('error', err); });
    return emitter;
  }

  remove(source: Stream<Quad>): EventEmitter {
    const emitter = new EventEmitter();
    this.delStream(<TSReadable<Quad>>source, {})
      .then(() => emitter.emit('end'))
      .catch((err) => emitter.emit('error', err));
    return emitter;
  }

  removeMatches(subject?: Quad_Subject, predicate?: Quad_Predicate, object?: Quad_Object, graph?: Quad_Graph, opts: GetOpts = emptyObject) {
    const source = this.match(subject, predicate, object, graph, opts);
    return this.remove(source);
  }

  deleteGraph(graph: Quad_Graph) {
    return this.removeMatches(undefined, undefined, undefined, graph);
  }

  async getApproximateSize(pattern: Pattern, opts: GetOpts = emptyObject) {
    await this.ensureReady();
    return await getApproximateSize(this, pattern, opts);
  }

  async sparql(query: Algebra.Operation|string, opts: SparqlOpts = emptyObject): Promise<QuadArrayResult|BindingArrayResult|VoidResult|BooleanResult> {
    this.ensureReady();
    return sparql(this, query, opts);
  }

  async put(quad: Quad, opts: PutOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    let batch = this.db.batch();
    if (opts.scope) {
      quad = opts.scope.parseQuad(quad, batch);
    }
    batch = this.indexes.reduce((indexBatch, index) => {
      const key = quadWriter.write(index.prefix, __value, quad, index.terms, this.prefixes);
      return indexBatch.put(key, copyBuffer(__value, 0, quadWriter.writtenValueBytes));
    }, batch);
    await this.writeBatch(batch, opts);
    return { type: ResultType.VOID };
  }

  async multiPut(quads: Quad[], opts: PutOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    let batch = this.db.batch();
    batch = quads.reduce((quadBatch, quad) => {
      if (opts.scope) {
        quad = opts.scope.parseQuad(quad, batch);
      }
      return this.indexes.reduce((indexBatch, index) => {
        const key = quadWriter.write(index.prefix, __value, quad, index.terms, this.prefixes);
        return indexBatch.put(key, copyBuffer(__value, 0, quadWriter.writtenValueBytes));
      }, quadBatch);
    }, batch);
    await this.writeBatch(batch, opts);
    return { type: ResultType.VOID };
  }

  async del(quad: Quad, opts: DelOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    const batch = this.indexes.reduce((indexBatch, index) => {
      const key = quadWriter.write(index.prefix, __value, quad, index.terms, this.prefixes);
      return indexBatch.del(key);
    }, this.db.batch());
    await this.writeBatch(batch, opts);
    return { type: ResultType.VOID };
  }

  async multiDel(quads: Quad[], opts: DelOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    const batch = quads.reduce((quadBatch, quad) => {
      return this.indexes.reduce((indexBatch, index) => {
        const key = quadWriter.write(index.prefix, __value, quad, index.terms, this.prefixes);
        return indexBatch.del(key);
      }, quadBatch);
    }, this.db.batch());
    await this.writeBatch(batch, opts);
    return { type: ResultType.VOID };
  }

  async patch(oldQuad: Quad, newQuad: Quad, opts: PatchOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    const batch = this.indexes.reduce((indexBatch, index) => {
      const oldKey = quadWriter.write(index.prefix, __value, oldQuad, index.terms, this.prefixes);
      indexBatch.del(oldKey);
      const newKey = quadWriter.write(index.prefix, __value, newQuad, index.terms, this.prefixes);
      return indexBatch.put(newKey, copyBuffer(__value, 0, quadWriter.writtenValueBytes));
    }, this.db.batch());
    await this.writeBatch(batch, opts);
    return { type: ResultType.VOID };
  }

  async multiPatch(oldQuads: Quad[], newQuads: Quad[], opts: PatchOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    let batch = this.db.batch();
    batch = oldQuads.reduce((quadBatch, oldQuad) => {
      return this.indexes.reduce((indexBatch, index) => {
        const oldKey = quadWriter.write(index.prefix, __value, oldQuad, index.terms, this.prefixes);
        return indexBatch.del(oldKey);
      }, quadBatch);
    }, batch);
    batch = newQuads.reduce((quadBatch, newQuad) => {
      return this.indexes.reduce((indexBatch, index) => {
        const key = quadWriter.write(index.prefix, __value, newQuad, index.terms, this.prefixes);
        return indexBatch.put(key, copyBuffer(__value, 0, quadWriter.writtenValueBytes));
      }, quadBatch);
    }, batch);
    await this.writeBatch(batch, opts);
    return { type: ResultType.VOID };
  }

  private async writeBatch(batch: AbstractChainedBatch, opts: BatchOpts) {
    if (opts.preWrite) {
      await opts.preWrite(batch);
    }
    await pFromCallback((cb) => { batch.write(cb); });
  }

  async get(pattern: Pattern, opts: GetOpts = emptyObject): Promise<QuadArrayResult> {
    this.ensureReady();
    const results = await this.getStream(pattern, opts);
    const items: Quad[] = await streamToArray(results.iterator);
    return { type: results.type, items };
  }

  async getStream(pattern: Pattern, opts: GetOpts = emptyObject): Promise<QuadStreamResult> {
    this.ensureReady();
    return await getStream(this, pattern, opts);
  }

  async putStream(source: TSReadable<Quad>, opts: PutStreamOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    const batchSize = opts.batchSize || 1;
    if (batchSize === 1) {
      await consumeOneByOne<Quad>(source, quad => this.put(quad, opts));
    } else {
      await consumeInBatches<Quad>(source, batchSize, quads => this.multiPut(quads, opts));
    }
    return { type: ResultType.VOID };
  }

  async delStream(source: TSReadable<Quad>, opts: DelStreamOpts = emptyObject): Promise<VoidResult> {
    this.ensureReady();
    const batchSize = opts.batchSize || 1;
    if (batchSize === 1) {
      await consumeOneByOne<Quad>(source, quad => this.del(quad));
    } else {
      await consumeInBatches<Quad>(source, batchSize, quads => this.multiDel(quads));
    }
    return { type: ResultType.VOID };
  }

  async sparqlStream(query: Algebra.Operation|string, opts: SparqlOpts = emptyObject): Promise<QuadStreamResult|BindingStreamResult|VoidResult|BooleanResult> {
    this.ensureReady();
    return await sparqlStream(this, query, opts);
  }

  async initScope(): Promise<Scope> {
    await this.ensureReady();
    return await Scope.init(this);
  }

  async loadScope(scopeId: string): Promise<Scope> {
    await this.ensureReady();
    return await Scope.load(this, scopeId);
  }

  async deleteScope(scopeId: string): Promise<void> {
    await this.ensureReady();
    await Scope.delete(this, scopeId);
  }

  async deleteAllScopes(): Promise<void> {
    await this.ensureReady();
    await Scope.delete(this);
  }

}
