import {Injectable} from '@angular/core';
import {CaldavCfg} from './caldav.model';
// @ts-ignore
import DavClient, {namespaces as NS} from 'cdav-library';
// @ts-ignore
import Calendar from 'cdav-library/models/calendar';
// @ts-ignore
import ICAL from 'ical.js';

import {from, Observable, throwError} from 'rxjs';
import {CaldavIssue} from './caldav-issue/caldav-issue.model';
import {CALDAV_TYPE} from '../../issue.const';
import {SearchResultItem} from '../../issue.model';
import {SnackService} from '../../../../core/snack/snack.service';
import {T} from '../../../../t.const';
import {catchError} from 'rxjs/operators';
import {HANDLED_ERROR_PROP_STR} from '../../../../app.constants';


interface ClientCache {
  client: DavClient;
  calendars: Map<string, Calendar>;
}

@Injectable({
              providedIn: 'root',
            })
export class CaldavClientService {

  private _clientCache = new Map<string, ClientCache>();

  constructor(
    private readonly _snackService: SnackService
  ) {
  }

  private _getXhrProvider(cfg: CaldavCfg) {
    function xhrProvider(): XMLHttpRequest {
      const xhr = new XMLHttpRequest();
      const oldOpen = xhr.open;

      // override open() method to add headers
      xhr.open = function() {
        // @ts-ignore
        const result = oldOpen.apply(this, arguments);
        // @ts-ignore
        xhr.setRequestHeader('X-Requested-With', 'SuperProductivity');
        xhr.setRequestHeader('Authorization', 'Basic ' + btoa(cfg.username + ':' + cfg.password));
        return result;
      };
      return xhr;
    }

    return xhrProvider;
  }

  private _handleNetErr(err: any) {
    this._snackService.open({
                              type: 'ERROR',
                              msg: T.F.CALDAV.S.ERR_NETWORK
                            });
    throw new Error('CALDAV NETWORK ERROR: ' + err);
  }

  private static _getCalendarUriFromUrl(url: string) {
    if (url.endsWith('/')) {
      url = url.substring(0, url.length - 1);
    }

    return url.substring(url.lastIndexOf('/') + 1);
  }

  async _get_client(cfg: CaldavCfg): Promise<ClientCache> {
    const client_key = `${cfg.caldavUrl}|${cfg.username}|${cfg.password}`;

    if (this._clientCache.has(client_key)) {
      return this._clientCache.get(client_key) as ClientCache;
    } else {
      const client = new DavClient({
                                     rootUrl: cfg.caldavUrl
                                   }, this._getXhrProvider(cfg));

      await client.connect({enableCalDAV: true}).catch((err: any) => this._handleNetErr(err));

      const cache = {
        client,
        calendars: new Map()
      };
      this._clientCache.set(client_key, cache);

      return cache;
    }
  }


  async _getCalendar(cfg: CaldavCfg) {
    const clientCache = await this._get_client(cfg);
    const resource = cfg.resourceName as string;

    if (clientCache.calendars.has(resource)) {
      return clientCache.calendars.get(resource);
    }

    const calendars = await clientCache.client.calendarHomes[0].findAllCalendars()
      .catch((err: any) => this._handleNetErr(err));

    const calendar = calendars.find((item: Calendar) => (item.displayname || CaldavClientService._getCalendarUriFromUrl(item.url)) === resource);

    if (calendar !== undefined) {
      clientCache.calendars.set(resource, calendar);
      return calendar;
    }

    this._snackService.open({
                              type: 'ERROR',
                              msg: T.F.CALDAV.S.CALENDAR_NOT_FOUND
                            });
    throw new Error('CALENDAR NOT FOUND: ' + cfg.resourceName);
  }

  private static async _getAllTodos(calendar: any, filterOpen: boolean) {
    const query = {
      name: [NS.IETF_CALDAV, 'comp-filter'],
      attributes: [
        ['name', 'VCALENDAR'],
      ],
      children: [{
        name: [NS.IETF_CALDAV, 'comp-filter'],
        attributes: [
          ['name', 'VTODO'],
        ],
      }],
    };

    if (filterOpen) {
      // @ts-ignore
      query.children[0].children = [{
        name: [NS.IETF_CALDAV, 'prop-filter'],
        attributes: [
          ['name', 'completed'],
        ],
        children: [{
          name: [NS.IETF_CALDAV, 'is-not-defined'],
        }]
      }];
    }

    return await calendar.calendarQuery([query]);
  }

  private static async _findTaskByUid(calendar: any, taskUid: string) {
    const query = {
      name: [NS.IETF_CALDAV, 'comp-filter'],
      attributes: [
        ['name', 'VCALENDAR'],
      ],
      children: [{
        name: [NS.IETF_CALDAV, 'comp-filter'],
        attributes: [
          ['name', 'VTODO'],
        ],
        children: [{
          name: [NS.IETF_CALDAV, 'prop-filter'],
          attributes: [
            ['name', 'uid'],
          ],
          children: [{
            name: [NS.IETF_CALDAV, 'text-match'],
            value: taskUid,
          }],
        }]
      }],
    };
    return await calendar.calendarQuery([query]);
  }


  private static _mapTask(task: any): CaldavIssue {
    const jCal = ICAL.parse(task.data);
    const comp = new ICAL.Component(jCal);
    const todo = comp.getFirstSubcomponent('vtodo');

    let categories: string[] = [];
    for (const cats of todo.getAllProperties('categories')) {
      if (cats) {
        categories = categories.concat(cats.getValues());
      }
    }

    const completed = todo.getFirstPropertyValue('completed');

    return {
      id: todo.getFirstPropertyValue('uid'),
      completed: !!completed,
      item_url: task.url,
      summary: todo.getFirstPropertyValue('summary') || '',
      due: todo.getFirstPropertyValue('due') || '',
      start: todo.getFirstPropertyValue('dtstart') || '',
      last_modified: todo.getFirstPropertyValue('last-modified').toUnixTime(),
      labels: categories,
      note: todo.getFirstPropertyValue('description') || ''
    };
  }

  private async _getTasks(cfg: CaldavCfg, filterOpen: boolean): Promise<CaldavIssue[]> {
    const cal = await this._getCalendar(cfg);
    const tasks = await CaldavClientService._getAllTodos(cal, filterOpen).catch((err: any) => this._handleNetErr(err));
    return tasks.map((t: any) => CaldavClientService._mapTask(t));
  }

  private async _getTask(cfg: CaldavCfg, uid: string): Promise<CaldavIssue> {
    const cal = await this._getCalendar(cfg);
    const task = await CaldavClientService._findTaskByUid(cal, uid).catch((err: any) => this._handleNetErr(err));

    if (task.length < 1) {
      this._snackService.open({
                                type: 'ERROR',
                                msg: T.F.CALDAV.S.ISSUE_NOT_FOUND
                              });
      throw new Error('ISSUE NOT FOUND: ' + uid);
    }

    return CaldavClientService._mapTask(task[0]);
  }

  getOpenTasks$(cfg: CaldavCfg): Observable<CaldavIssue[]> {
    return from(this._getTasks(cfg, true)).pipe(
      catchError((err) => throwError({[HANDLED_ERROR_PROP_STR]: 'Caldav: ' + err})));
  }

  searchOpenTasks$(text: string, cfg: CaldavCfg): Observable<SearchResultItem[]> {
    return from(this._getTasks(cfg, true)
                  .then(tasks =>
                          tasks.filter(todo => todo.summary.includes(text))
                            .map(todo => {
                              return {
                                title: todo.summary,
                                issueType: CALDAV_TYPE,
                                issueData: todo,
                              };
                            })
                  )).pipe(
      catchError((err) => throwError({[HANDLED_ERROR_PROP_STR]: 'Caldav: ' + err})));
  }

  getById$(id: string | number, caldavCfg: CaldavCfg): Observable<CaldavIssue> {
    console.log(id);
    if (typeof id === 'number') {
      id = id.toString(10);
    }
    return from(this._getTask(caldavCfg, id)).pipe(
      catchError((err) => throwError({[HANDLED_ERROR_PROP_STR]: 'Caldav: ' + err})));
  }

  getByIds$(ids: string[], cfg: CaldavCfg): Observable<CaldavIssue[]> {
    return from(this._getTasks(cfg, false)
                  .then(tasks => tasks
                    .filter(task => task.id in ids))).pipe(
      catchError((err) => throwError({[HANDLED_ERROR_PROP_STR]: 'Caldav: ' + err})));
  }

}