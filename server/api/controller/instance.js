const { APUser, Instance, Resource } = require('../models/models')
const { getActor, unfollowActor, followActor, getNodeInfo, getInstance } = require('../../federation/helpers')
const axios = require('axios')
const get = require('lodash/get')

const Sequelize = require('sequelize')
const log = require('../../log')

const instancesController = {

  /**
   * get all fediverse instances
   * used in moderation panel
   */
  async getAll (req, res) {
    const instances = await Instance.findAll({
      attributes: [
        'domain', 'name', 'data', 'blocked',
        [Sequelize.fn('COUNT', Sequelize.col('ap_users.ap_id')), 'users']
      ],
      order: [[Sequelize.fn('COUNT', Sequelize.col('ap_users.ap_id')), 'DESC']],
      group: ['instance.domain'],
      include: [{ model: APUser, attributes: [] }]
    })
    return res.json(instances)
  },

  // async getUsedInstance (req, res) {
  //   // const ap_users = await APUser.findAll({
  //   //   attributes: ['ap_id', 'blocked', 'instanceDomain'],
  //   //   where: { [Op.or]: [{ follower: true }, { blocked: true }] },
  //   //   include: [
  //   //     { model: Resource, attributes: ['id', 'eventId'], include: [{ model: Event, attributes: ['title'] }] },
  //   //     { model: Instance, attributes: ['blocked', 'name', 'domain'] }],
  //   //   nest: true,
  //   //   raw: true
  //   // })
  //   const instances = await Instance.findAll({
  //     include: [
  //       { model: APUser, where: { [Op.or]: [{ follower: true }, { blocked: true }] }, attributes: [] }
  //     ],
  //     attributes: ['domain', 'name', 'blocked'],
  //     raw: true
  //   })
  //   console.error(instances)
  //   res.json(instances)
  // },

  /**
   * get instance's users
   */
  async get (req, res) {
    const ap_users = await APUser.findAll({ where: { instanceDomain: req.params.instance_domain }, include: [Resource] })
    return res.json(ap_users)
  },

  // get trusted users
  async getTrusted (req, res) {
    const trusted_users = await APUser.findAll({ where: { trusted: true }, include: [Instance]})
    return res.json(trusted_users)
  },

  // toggle instance block
  async toggleBlock (req, res) {
    const instance = await Instance.findByPk(req.body.instance)
    if (!instance) { return res.status(404).send('Not found') }
    await instance.update({ blocked: req.body.blocked })
    return res.json(instance)
  },


  async removeTrust (req, res) {
    let ap_id = req.query.ap_id
    log.info(`Remove trust on node ${ap_id} ...`)
    
    try {
      const actor = await getActor(ap_id)
      if (!actor || !actor.trusted) {
        return res.sendStatus(404)
      }

      if (actor.following) {
        // unfollow
        await unfollowActor(actor)
      }

      // remove trust
      await actor.update({ trusted: false })

    } catch (e) {
      log.warn(e)
      return res.status(400).send(e)      
    }

    return res.sendStatus(200)

  },

  async addTrust (req, res) {

    /**
     * url
     * in case we have a @ we should use webfinger 
     * in case we have a full url could be an actor
     * or a nodeinfo url to search for 
     */
    let url = req.body.url
    let instance

    if (url.includes('@')) {
      const [ user, instance_url ] = url.replace(/^@/,'').split('@')
      log.debug('[FEDI] Adds user: %s and instance: %s because url was: %s', user, instance_url, url)
      try {
        instance = await getInstance('https:// ' + instance_url)
        if (!instance) { 
          return res.sendStatus(404)
        }
        const webfinger = await axios.get(`https://${instance_url}/.well-known/webfinger?resource=acct:${user}@${instance_url}`).then(res => res.data)
        if (webfinger?.links) {
          const actor_url = webfinger.links.find(l => l.rel === 'self')
          if (!actor_url) {
            log.warn('[FEDI] Cannot found `self` links in webfinger of %s', url)
            return res.sendStatus(404)
          }

          log.info(`[FEDI] Adding trusted instance ${instance_url} and actor ${actor_url.href}...`)
          const actor = await getActor(actor_url.href, instance)
          log.debug('[FEDI] Actor %s', actor)
          await actor.update({ trusted: true })
          return res.json(actor)    
        }
      } catch (e) {
        log.error('[FEDI] Wrong webfinger response from %s: %s ', url, e?.response?.data ?? String(e))
        return res.sendStatus(404)
      }
    }

    try {
      if (!url.startsWith('http')) {
        url = `https://${url}`
      }
      url = url.replace(/\/$/, '')

      log.info(`[FEDI] Adding trusted instance ${url} ...`)
      instance = await getInstance(url)
      if (!instance) {
        return res.sendStatus(404)
      }

      if (instance?.applicationActor) {
        log.debug('[FEDI] This node supports FEP-2677 and applicationActor is: %s', instance.applicationActor)
        const actor = await getActor(instance.applicationActor, instance)
        log.debug('[FEDI] Actor %s', actor)
        await actor.update({ trusted: true })
        return res.json(actor)
      }

      // if (nodeInfo?.software?.name === 'Mobilizon') {
      //   instance.actor = 'relay'
      // } else if (nodeInfo?.software?.name === 'gancio') {
      //   instance.actor = get(nodeInfo, 'metadata.nodeActor', 'relay')
      // }
      // log.debug(`[FEDI] instance .well-known: ${instance.name} / ${instance.applicationActor}`)

      // // if we have an actor, let's make a new friend
      // if (instance.actor) {

      //   // send a well-known request
      //   const instance_hostname = new URL(url).host
      //   const { data: wellknown } = await axios.get(`${url}/.well-known/webfinger?resource=acct:${instance.actor}@${instance_hostname}`)

      //   // search for actor url
      //   const actorURL = wellknown?.links.find(l => l.rel === 'self').href

      //   // retrieve the AP actor and flat it as trusted
      //   const actor = await getActor(actorURL, instance)
      //   await actor.update({ trusted: true })

      //   return res.json(actor)
      // }
    } catch (e) {
      console.error(e) 
      log.error('[FEDI] Error adding trusted instance %s', e?.response?.data ?? String(e))
      return res.status(400).send(e)
    }
  }
}

module.exports = instancesController
